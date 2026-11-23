// Nano Studio Conquest's built world map and 1914 scenario (renderer/features/conquest/data/world-1914, made by
// tools/build-conquest-maps.mjs), checked against docs/conquest-architecture.md sections 3 and 4:
// - ids.png: RGB, no alpha or colour profile, 8192x4096; every id in it is a province, every province has pixels,
//   every anchor (x, y) lies on its own province;
// - adjacency: symmetric, rivers inside adj, straits inside adj and between land, one connected graph;
// - scenario: every land province owned once, capitals owned, every tag used is a nation, every nation has every
//   field, production lines within the military factories, neighbours' colours apart in lightness and hue,
//   events written only in the section 4 vocabulary;
// - the 1914 owner of named places on every continent, written here independently of the ownership table;
// - province size by theatre (tools/conquest-data/theatres.json): in the fine theatres none over twice its target or
//   under the clickable minimum, every province one 4-connected region apart from islands and real exclaves, names
//   unique within a nation, the front cities owned by their 1914 nation, and fronts of comparable granularity;
// - navy and stock on every nation, and every province reference in the scenario owned as it implies;
// - output sizes, and a second build from the Natural Earth sources giving the same bytes (skipped without sources).
// Writes verify/out/conquest-europe-1914.png (Europe and the Near East at texture resolution, borders and the front
// cities) to look at.
// Usage: node verify/conquest-maps.mjs
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'renderer/features/conquest/data/world-1914');
const SRC = path.join(ROOT, 'verify/out/downloads-cache/natural-earth');

const S = JSON.stringify;
const results = [];
const check = (ok, label) => { results.push({ ok: !!ok, label }); if (!ok) console.log(`FAIL ${label}`); };
const eq = (got, want, label) => check(S(got) === S(want), `${label}${S(got) === S(want) ? '' : ` (got ${S(got)}, want ${S(want)})`}`);
async function section(name, fn) { try { await fn(); } catch (err) { check(false, `${name}: ${err.stack}`); } }

function readPng(buf) {
  let o = 8, w = 0, h = 0, depth = 0, type = 0;
  const idat = [], chunks = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), t = buf.toString('ascii', o + 4, o + 8);
    chunks.push(t);
    if (t === 'IHDR') { w = buf.readUInt32BE(o + 8); h = buf.readUInt32BE(o + 12); depth = buf[o + 16]; type = buf[o + 17]; }
    if (t === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), s = w * 3, out = Buffer.alloc(s * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (s + 1)], row = raw.subarray(y * (s + 1) + 1, (y + 1) * (s + 1));
    for (let i = 0; i < s; i++) {
      const a = i >= 3 ? out[y * s + i - 3] : 0, b = y ? out[(y - 1) * s + i] : 0, c = y && i >= 3 ? out[(y - 1) * s + i - 3] : 0;
      let p = row[i];
      if (f === 1) p += a; else if (f === 2) p += b; else if (f === 3) p += (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * s + i] = p & 255;
    }
  }
  const ids = new Uint32Array(w * h);
  for (let i = 0; i < w * h; i++) ids[i] = out[i * 3] << 16 | out[i * 3 + 1] << 8 | out[i * 3 + 2];
  return { w, h, depth, type, chunks, ids };
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function encodePng(w, h, rgb) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// 5x7 capitals for the labels of the Europe picture.
const GLYPHS = Object.fromEntries(Object.entries({
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#', B: '####.|#...#|#...#|####.|#...#|#...#|####.', C: '.###.|#...#|#....|#....|#....|#...#|.###.',
  D: '####.|#...#|#...#|#...#|#...#|#...#|####.', E: '#####|#....|#....|####.|#....|#....|#####', F: '#####|#....|#....|####.|#....|#....|#....',
  G: '.###.|#...#|#....|#.###|#...#|#...#|.####', H: '#...#|#...#|#...#|#####|#...#|#...#|#...#', I: '.###.|..#..|..#..|..#..|..#..|..#..|.###.',
  J: '..###|...#.|...#.|...#.|...#.|#..#.|.##..', K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#', L: '#....|#....|#....|#....|#....|#....|#####',
  M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#', N: '#...#|#...#|##..#|#.#.#|#..##|#...#|#...#', O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.',
  P: '####.|#...#|#...#|####.|#....|#....|#....', Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#', R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '.####|#....|#....|.###.|....#|....#|####.', T: '#####|..#..|..#..|..#..|..#..|..#..|..#..', U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.',
  V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..', W: '#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.', X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..', Z: '#####|....#|...#.|..#..|.#...|#....|#####', '-': '.....|.....|.....|#####|.....|.....|.....',
  ' ': '.....|.....|.....|.....|.....|.....|.....',
}).map(([k, v]) => [k, v.split('|')]));

const map = JSON.parse(fs.readFileSync(path.join(DATA, 'map.json'), 'utf8'));
const scenario = JSON.parse(fs.readFileSync(path.join(DATA, 'scenario.json'), 'utf8'));
const png = readPng(fs.readFileSync(path.join(DATA, 'ids.png')));
const P = map.provinces, N = P.length - 1;
const land = P.filter((p) => p && !p.sea), seaZones = P.filter((p) => p && p.sea);
const ownerOf = new Map();
for (const [tag, list] of Object.entries(scenario.owner)) for (const p of list) ownerOf.set(p, [...(ownerOf.get(p) || []), tag]);
const nationByTag = new Map(scenario.nations.map((n) => [n.tag, n]));
const theatres = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/conquest-data/theatres.json'), 'utf8'));
const W = 8192, PPD = W / 360;
const at = (lon, lat) => {
  const x0 = Math.floor((lon + 180) * PPD), y0 = Math.floor((90 - lat) * PPD);
  for (let r = 0; r <= 6; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const v = png.ids[(y0 + dy) * W + ((x0 + dx + W) % W)];
    if (v && !P[v].sea) return v;
  }
  return 0;
};

await section('texture', () => {
  eq([png.w, png.h, png.depth, png.type], [8192, 4096, 8, 2], 'ids.png is 8192x4096 8-bit RGB without alpha');
  eq(png.chunks.filter((c) => c !== 'IDAT'), ['IHDR', 'IEND'], 'ids.png carries no colour profile or other chunks');
  eq([map.texture.width, map.texture.height, map.texture.file], [8192, 4096, 'ids.png'], 'map.json names the texture and its size');
  check(Math.abs(map.projection.pxPerDeg - 8192 / 360) < 1e-3 && map.projection.lon0 === -180 && map.projection.lat0 === 90, 'projection is equirectangular from -180, 90 at 8192/360 px per degree');
  const count = new Int32Array(N + 1);
  let stray = 0;
  for (let i = 0; i < png.ids.length; i++) { const v = png.ids[i]; if (v > N) stray++; else count[v]++; }
  eq(stray, 0, 'every id in ids.png is a province');
  eq(P.slice(1).filter((p) => !count[p.id]).map((p) => p.name), [], 'every province has pixels');
  eq(P.slice(1).filter((p) => png.ids[p.y * 8192 + p.x] !== p.id).map((p) => p.name), [], 'every anchor (x, y) lies on its own province');
});

await section('ids and shape', () => {
  check(P[0] === null, 'provinces[0] is null');
  eq(P.slice(1).filter((p, k) => p.id !== k + 1).length, 0, 'ids are 1..N without gaps');
  const firstSea = P.findIndex((p) => p && p.sea);
  check(firstSea > 0 && P.slice(firstSea).every((p) => p.sea), 'land provinces come first, then sea zones');
  check(land.length >= 5500 && land.length <= 7500, `5,500 to 7,500 land provinces (${land.length})`);
  check(seaZones.length >= 40, `several dozen sea zones (${seaZones.length})`);
  const terrains = new Set(['plains', 'forest', 'hills', 'mountain', 'marsh', 'desert', 'urban']);
  const climates = new Set(['arctic', 'cold', 'temperate', 'mediterranean', 'arid', 'tropical']);
  eq(land.filter((p) => !terrains.has(p.terrain) || !climates.has(p.climate) || typeof p.coastal !== 'boolean' || typeof p.port !== 'boolean' || !p.iso || !Array.isArray(p.river) || !(p.area > 0)).map((p) => p.name), [], 'every land province has terrain, climate, coastal, port, iso, river and area');
  const seenTerrain = new Set(land.map((p) => p.terrain));
  eq([...terrains].filter((t) => !seenTerrain.has(t)), [], 'every terrain class occurs');
  eq(land.filter((p) => p.port && !p.coastal).length, 0, 'only coastal provinces are ports');
});

await section('adjacency', () => {
  const adj = P.map((p) => new Set(p ? p.adj : []));
  const asym = [];
  for (const p of P.slice(1)) for (const q of p.adj) if (q < 1 || q > N || q === p.id || !adj[q].has(p.id)) asym.push([p.id, q]);
  eq(asym.slice(0, 5), [], 'adjacency is symmetric, without self or unknown ids');
  eq(land.filter((p) => p.river.some((q) => !adj[p.id].has(q) || P[q].sea || !P[q].river.includes(p.id))).map((p) => p.name), [], 'every river entry is a land neighbour, both ways');
  check(land.reduce((s, p) => s + p.river.length, 0) > 200, 'rivers mark a few hundred borders');
  eq(land.filter((p) => p.coastal !== p.adj.some((q) => P[q].sea)).length, 0, 'coastal means a sea zone in adj');
  eq(map.straits.filter(([a, b]) => P[a].sea || P[b].sea || !adj[a].has(b)), [], 'straits join land provinces and are in adj');
  eq((map.passages || []).filter(([a, b]) => !P[a].sea || !P[b].sea || !adj[a].has(b)), [], 'passages join sea zones and are in adj');
  const seen = new Uint8Array(N + 1), stack = [land[0].id];
  seen[land[0].id] = 1;
  while (stack.length) for (const q of P[stack.pop()].adj) if (!seen[q]) { seen[q] = 1; stack.push(q); }
  eq(P.slice(1).filter((p) => !seen[p.id]).map((p) => p.name).slice(0, 10), [], 'every province reaches every other through land, straits and sea zones');
  const named = (name) => land.find((p) => p.name === name);
  const pair = (a, b) => adj[named(a).id].has(named(b).id);
  check(pair('Messina', 'Reggio Calabria'), 'Sicily is joined to Calabria across the Strait of Messina');
});

await section('ownership', () => {
  eq(land.filter((p) => (ownerOf.get(p.id) || []).length !== 1).map((p) => `${p.name}: ${ownerOf.get(p.id) || 'nobody'}`).slice(0, 10), [], 'every land province has exactly one owner');
  eq([...ownerOf.keys()].filter((id) => !P[id] || P[id].sea), [], 'only land provinces are owned');
  eq(scenario.nations.filter((n) => !scenario.owner[n.tag]?.includes(n.capital)).map((n) => n.tag), [], 'every nation owns its capital');
  const fields = ['tag', 'name', 'color', 'capital', 'bloc', 'major', 'manpower', 'personality', 'goals', 'generals', 'templates', 'lines'];
  eq(scenario.nations.filter((n) => fields.some((f) => !(f in n))).map((n) => n.tag), [], 'every nation has every field');
  eq(scenario.nations.filter((n) => !/^[A-Z]{3}$/.test(n.tag) || !/^#[0-9a-f]{6}$/.test(n.color)).map((n) => n.tag), [], 'tags are three capitals, colours are #rrggbb');

  const tags = new Set(scenario.nations.map((n) => n.tag));
  const used = [...Object.keys(scenario.owner), ...Object.keys(scenario.cores), ...scenario.armies.map((a) => a.nation), ...scenario.alliances.flat(), ...scenario.wars.flat()];
  for (const n of scenario.nations) for (const g of n.goals) if (g.nation) used.push(g.nation);
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); else if (typeof v === 'string' && /^[A-Z]{3}$/.test(v)) used.push(v); };
  walk(scenario.events); for (const n of scenario.nations) walk(n.goals.map((g) => g.when || null));
  eq([...new Set(used)].filter((t) => !tags.has(t)), [], 'every tag used anywhere is a nation');

  eq(Object.entries(scenario.cores).filter(([, l]) => l.some((p) => !P[p] || P[p].sea)).map(([t]) => t), [], 'cores are land provinces');
  const majors = scenario.nations.filter((n) => n.major).map((n) => n.tag).sort();
  eq(majors, ['AUT', 'DEU', 'FRA', 'GBR', 'ITA', 'JPN', 'RUS', 'TUR', 'USA'], 'the eight great powers and the Ottomans are majors');
  const bloc = Object.fromEntries(scenario.nations.map((n) => [n.tag, n.bloc]));
  eq(['FRA', 'GBR', 'RUS', 'SRB', 'DEU', 'AUT', 'BEL', 'ITA', 'TUR', 'USA', 'JPN', 'ROU', 'BUL'].map((t) => bloc[t]),
    ['entente', 'entente', 'entente', 'entente', 'central', 'central', null, null, null, null, null, null, null], 'blocs of 28 June 1914');
  check(nationByTag.get('GBR').goals.some((g) => g.kind === 'defend' && g.nation === 'BEL'), 'Britain has a goal to defend Belgium');
  const nameIds = (iso, names) => land.filter((p) => p.iso === iso && names.includes(p.name)).map((p) => p.id);
  const al = nameIds('FRA', ['Moselle', 'Bas-Rhin', 'Haute-Rhin']);
  check(al.length === 3 && al.every((p) => scenario.cores.FRA.includes(p) && ownerOf.get(p)[0] === 'DEU'), 'Alsace-Lorraine is German and a French core');
  check([[11.12, 46.07], [13.78, 45.65]].every(([lon, lat]) => scenario.cores.ITA.includes(at(lon, lat))), 'Trento and Trieste are Italian cores');
  check(!nationByTag.has('POL'), 'Poland has no nation in 1914');

  for (const n of scenario.nations) {
    const mil = scenario.owner[n.tag].reduce((s, p) => s + (scenario.provinces[p]?.mil || 0), 0);
    if (n.lines.reduce((s, l) => s + l.factories, 0) > Math.max(1, mil)) check(false, `${n.tag}'s production lines fit its military factories`);
  }
  const genOK = scenario.armies.every((a) => (!a.general || nationByTag.get(a.nation).generals.some((g) => g.name === a.general)) && nationByTag.get(a.nation).templates.some((t) => t.id === a.template) && a.at.every((p) => ownerOf.get(p)?.[0] === a.nation) && a.divisions > 0);
  check(genOK, 'armies use their nation\'s generals and templates and stand in their own provinces');
  check(/game values/.test(scenario.notes), 'notes say the numbers are game values');
});

await section('colours', () => {
  const lab = (hex) => {
    const c = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255).map((v) => (v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92));
    const X = (0.4124 * c[0] + 0.3576 * c[1] + 0.1805 * c[2]) / 0.95047, Y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2], Z = (0.0193 * c[0] + 0.1192 * c[1] + 0.9505 * c[2]) / 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
  };
  const bad = new Set();
  for (const p of land) for (const q of p.adj) {
    if (P[q].sea) continue;
    const a = ownerOf.get(p.id)[0], b = ownerOf.get(q)[0];
    if (a === b) continue;
    const A = lab(nationByTag.get(a).color), B = lab(nationByTag.get(b).color);
    if (Math.abs(A[0] - B[0]) < 6 || Math.hypot(A[1] - B[1], A[2] - B[2]) < 20) bad.add([a, b].sort().join('-'));
  }
  eq([...bad], [], 'neighbouring nations differ in lightness (6 L*) and in hue (20 a*b*)');
});

await section('events vocabulary', () => {
  const conds = new Set(['all', 'any', 'not', 'war', 'atWar', 'ally', 'bloc', 'controls', 'controlsAny', 'fatigueAbove', 'dateAfter', 'daysSince', 'fired', 'chance']);
  const effects = new Set(['declareWar', 'peace', 'ally', 'joinBloc', 'collapse', 'mobilise', 'log']);
  const ids = new Set(scenario.events.map((e) => e.id));
  const bad = [];
  const cond = (c, where) => {
    const keys = Object.keys(c);
    if (keys.length !== 1 || !conds.has(keys[0])) return bad.push(`${where}: ${S(c)}`);
    const [k] = keys, v = c[k];
    if (k === 'all' || k === 'any') v.forEach((x) => cond(x, where));
    if (k === 'not') cond(v, where);
    if ((k === 'fired' && !ids.has(v)) || (k === 'daysSince' && !ids.has(v[0]))) bad.push(`${where}: unknown event in ${S(c)}`);
    if (k === 'chance' && !(v > 0 && v <= 1000)) bad.push(`${where}: chance ${v}`);
    if ((k === 'controls' || k === 'controlsAny') && !v[1].every((p) => P[p] && !P[p].sea)) bad.push(`${where}: ${k} names a non-land province`);
  };
  for (const e of scenario.events) {
    cond(e.when, e.id);
    for (const x of e.effects) if (Object.keys(x).length !== 1 || !effects.has(Object.keys(x)[0])) bad.push(`${e.id}: effect ${S(x)}`);
    if (typeof e.once !== 'boolean') bad.push(`${e.id}: once`);
  }
  for (const n of scenario.nations) for (const g of n.goals) if (g.when) cond(g.when, `${n.tag} goal ${g.id}`);
  eq(bad, [], 'events and goals use only the section 4 vocabulary');
  eq(ids.size, scenario.events.length, 'event ids are unique');
  for (const id of ['aut-declares-srb', 'rus-mobilises', 'deu-declares-rus', 'deu-declares-fra', 'belgium-violated', 'gbr-enters', 'ottoman-entry', 'italy-entente', 'us-entry', 'russian-collapse']) check(ids.has(id), `event ${id} exists`);
});

// [lon, lat, 1914 owner]: written from the history, not from tools/conquest-data.
const SAMPLES = {
  Strasbourg: [7.75, 48.58, 'DEU'], Metz: [6.18, 49.12, 'DEU'], Colmar: [7.36, 48.08, 'DEU'], Nancy: [6.18, 48.69, 'FRA'], Belfort: [6.86, 47.64, 'FRA'],
  Paris: [2.35, 48.86, 'FRA'], Brussels: [4.35, 50.85, 'BEL'], Liège: [5.57, 50.63, 'BEL'], Amsterdam: [4.9, 52.37, 'NLD'], Luxembourg: [6.13, 49.61, 'LUX'],
  Berlin: [13.4, 52.52, 'DEU'], Poznań: [16.93, 52.41, 'DEU'], Gdańsk: [18.65, 54.35, 'DEU'], Wrocław: [17.04, 51.11, 'DEU'], Kaliningrad: [20.51, 54.71, 'DEU'],
  Klaipėda: [21.13, 55.71, 'DEU'], Sønderborg: [9.79, 54.91, 'DEU'], Aabenraa: [9.42, 55.04, 'DEU'], Kolding: [9.47, 55.49, 'DNK'], Copenhagen: [12.57, 55.68, 'DNK'],
  Warsaw: [21.01, 52.23, 'RUS'], Łódź: [19.46, 51.76, 'RUS'], Kraków: [19.94, 50.06, 'AUT'], Lviv: [24.03, 49.84, 'AUT'], Chernivtsi: [25.94, 48.29, 'AUT'],
  Kyiv: [30.52, 50.45, 'RUS'], Helsinki: [24.94, 60.17, 'RUS'], Tallinn: [24.75, 59.44, 'RUS'], Riga: [24.1, 56.95, 'RUS'], Chișinău: [28.86, 47.01, 'RUS'],
  Trieste: [13.78, 45.65, 'AUT'], Trento: [11.12, 46.07, 'AUT'], Bolzano: [11.35, 46.5, 'AUT'], Udine: [13.23, 46.06, 'ITA'], Rome: [12.5, 41.9, 'ITA'],
  Sarajevo: [18.41, 43.86, 'AUT'], Zagreb: [15.98, 45.81, 'AUT'], Prague: [14.42, 50.08, 'AUT'], Cluj: [23.6, 46.77, 'AUT'], 'Novi Sad': [19.83, 45.25, 'AUT'],
  Dubrovnik: [18.09, 42.65, 'AUT'], Belgrade: [20.46, 44.82, 'SRB'], Skopje: [21.43, 42.0, 'SRB'], Bitola: [21.33, 41.03, 'SRB'], Pristina: [21.16, 42.66, 'SRB'],
  Cetinje: [18.92, 42.39, 'MNE'], Pljevlja: [19.36, 43.36, 'MNE'], Thessaloniki: [22.94, 40.64, 'GRC'], Ioannina: [20.85, 39.66, 'GRC'], Kavala: [24.41, 40.94, 'GRC'],
  Alexandroupoli: [25.87, 40.85, 'BUL'], Rhodes: [28.22, 36.43, 'ITA'], Heraklion: [25.13, 35.34, 'GRC'], Mytilene: [26.55, 39.1, 'GRC'], Dobrich: [27.83, 43.57, 'ROU'],
  Bucharest: [26.1, 44.43, 'ROU'], Sofia: [23.32, 42.7, 'BUL'], Istanbul: [28.98, 41.01, 'TUR'], Edirne: [26.56, 41.68, 'TUR'], Kars: [43.1, 40.6, 'RUS'],
  Batumi: [41.64, 41.64, 'RUS'], Baku: [49.87, 40.41, 'RUS'], Tirana: [19.82, 41.33, 'ALB'], Dublin: [-6.26, 53.35, 'GBR'], Valletta: [14.51, 35.9, 'GBR'],
  Reykjavík: [-21.94, 64.15, 'DNK'], Oslo: [10.75, 59.91, 'NOR'], Stockholm: [18.07, 59.33, 'SWE'], Bern: [7.45, 46.95, 'CHE'], Madrid: [-3.7, 40.42, 'ESP'],
  Lisbon: [-9.14, 38.72, 'POR'], Nicosia: [33.36, 35.17, 'GBR'],
  Baghdad: [44.37, 33.31, 'TUR'], Basra: [47.81, 30.5, 'TUR'], Damascus: [36.29, 33.51, 'TUR'], Jerusalem: [35.22, 31.78, 'TUR'], Beirut: [35.5, 33.89, 'TUR'],
  Mecca: [39.83, 21.42, 'TUR'], Riyadh: [46.72, 24.69, 'NJD'], Kuwait: [47.98, 29.37, 'GBR'], Aden: [45.03, 12.79, 'GBR'], "Sana'a": [44.21, 15.35, 'TUR'],
  Muscat: [58.59, 23.61, 'OMN'], Tehran: [51.39, 35.69, 'PRS'], Kabul: [69.17, 34.53, 'AFG'], Tashkent: [69.24, 41.3, 'RUS'], Delhi: [77.21, 28.61, 'GBR'],
  Karachi: [67.0, 24.86, 'GBR'], Dhaka: [90.41, 23.81, 'GBR'], Colombo: [79.86, 6.93, 'GBR'], Yangon: [96.16, 16.84, 'GBR'], Kathmandu: [85.32, 27.71, 'NPL'],
  Lhasa: [91.13, 29.65, 'TIB'], Ulaanbaatar: [106.92, 47.92, 'MNG'], Beijing: [116.4, 39.9, 'CHN'], Shanghai: [121.47, 31.23, 'CHN'], 'Hong Kong': [114.17, 22.3, 'GBR'],
  Seoul: [126.98, 37.57, 'JPN'], Pyongyang: [125.76, 39.02, 'JPN'], Taipei: [121.56, 25.04, 'JPN'], Tokyo: [139.69, 35.69, 'JPN'], 'Yuzhno-Sakhalinsk': [142.73, 46.96, 'JPN'],
  Okha: [142.95, 53.57, 'RUS'], Vladivostok: [131.89, 43.12, 'RUS'], Hanoi: [105.85, 21.03, 'FRA'], Saigon: [106.66, 10.76, 'FRA'], 'Phnom Penh': [104.92, 11.56, 'FRA'],
  Bangkok: [100.5, 13.75, 'SIA'], Singapore: [103.82, 1.35, 'GBR'], 'Kuala Lumpur': [101.69, 3.14, 'GBR'], Batavia: [106.85, -6.2, 'NLD'], Dili: [125.57, -8.55, 'POR'],
  Manila: [120.98, 14.6, 'USA'], Panaji: [73.83, 15.49, 'POR'], Pondicherry: [79.83, 11.93, 'FRA'],
  Algiers: [3.06, 36.75, 'FRA'], Tunis: [10.18, 36.8, 'FRA'], Rabat: [-6.84, 34.02, 'FRA'], Tétouan: [-5.37, 35.57, 'ESP'], Tripoli: [13.18, 32.89, 'ITA'],
  Cairo: [31.24, 30.04, 'GBR'], Khartoum: [32.53, 15.6, 'GBR'], 'Addis Ababa': [38.75, 9.03, 'ETH'], Asmara: [38.93, 15.32, 'ITA'], Mogadishu: [45.34, 2.04, 'ITA'],
  Kismayo: [42.54, -0.36, 'GBR'], Nairobi: [36.82, -1.29, 'GBR'], 'Dar es Salaam': [39.28, -6.82, 'DEU'], Zanzibar: [39.2, -6.16, 'GBR'], Kigali: [30.06, -1.95, 'DEU'],
  Windhoek: [17.08, -22.56, 'DEU'], Douala: [9.7, 4.05, 'DEU'], Lomé: [1.22, 6.13, 'DEU'], Ho: [0.47, 6.6, 'DEU'], Accra: [-0.2, 5.56, 'GBR'],
  Lagos: [3.39, 6.45, 'GBR'], Dakar: [-17.45, 14.69, 'FRA'], Monrovia: [-10.8, 6.3, 'LBR'], Kinshasa: [15.31, -4.32, 'BEL'], Luanda: [13.23, -8.84, 'POR'],
  Maputo: [32.57, -25.97, 'POR'], 'Cape Town': [18.42, -33.92, 'GBR'], Antananarivo: [47.52, -18.91, 'FRA'], Malabo: [8.78, 3.75, 'ESP'], Djibouti: [43.14, 11.59, 'FRA'],
  Washington: [-77.04, 38.9, 'USA'], Ottawa: [-75.7, 45.42, 'GBR'], 'Mexico City': [-99.13, 19.43, 'MEX'], Havana: [-82.37, 23.11, 'CUB'], 'San Juan': [-66.1, 18.47, 'USA'],
  'Charlotte Amalie': [-64.93, 18.34, 'DNK'], Kingston: [-76.79, 17.99, 'GBR'], Panama: [-79.52, 8.98, 'PAN'], Bogotá: [-74.07, 4.71, 'COL'], Lima: [-77.04, -12.05, 'PRU'],
  Tacna: [-70.25, -18.01, 'CHL'], 'La Paz': [-68.15, -16.5, 'BOL'], Santiago: [-70.67, -33.45, 'CHL'], 'Buenos Aires': [-58.38, -34.6, 'ARG'], 'Rio de Janeiro': [-43.17, -22.91, 'BRA'],
  Georgetown: [-58.16, 6.8, 'GBR'], Paramaribo: [-55.2, 5.85, 'NLD'], Cayenne: [-52.33, 4.92, 'FRA'], Nuuk: [-51.72, 64.18, 'DNK'], Honolulu: [-157.86, 21.31, 'USA'],
  Anchorage: [-149.9, 61.22, 'USA'],
  Sydney: [151.21, -33.87, 'GBR'], Wellington: [174.78, -41.29, 'GBR'], 'Port Moresby': [147.18, -9.44, 'GBR'], Rabaul: [152.17, -4.2, 'DEU'], Apia: [-171.76, -13.83, 'DEU'],
  'Pago Pago': [-170.7, -14.28, 'USA'], Nouméa: [166.45, -22.26, 'FRA'], Suva: [178.44, -18.14, 'GBR'], Hagåtña: [144.75, 13.47, 'USA'], Saipan: [145.75, 15.18, 'DEU'],
};

await section('1914 owners of named places', () => {
  const wrong = [];
  for (const [name, [lon, lat, want]] of Object.entries(SAMPLES)) {
    const p = at(lon, lat), got = p ? ownerOf.get(p)?.[0] : 'sea';
    if (got !== want) wrong.push(`${name} ${got} (want ${want})`);
  }
  check(Object.keys(SAMPLES).length >= 60, `the sample covers at least 60 places (${Object.keys(SAMPLES).length})`);
  eq(wrong, [], 'every sampled place has its 1914 owner');
});

// [lon, lat, 1914 owner] of the cities the fronts of 1914-1918 ran past or aimed at; written from the history.
const FRONT = {
  Cologne: [6.96, 50.94, 'DEU'], Aachen: [6.08, 50.78, 'DEU'], Koblenz: [7.6, 50.36, 'DEU'], Trier: [6.64, 49.75, 'DEU'], Saarbrücken: [6.99, 49.24, 'DEU'],
  Metz: [6.18, 49.12, 'DEU'], Strasbourg: [7.75, 48.58, 'DEU'], Mulhouse: [7.34, 47.75, 'DEU'], Karlsruhe: [8.4, 49.01, 'DEU'], Stuttgart: [9.18, 48.78, 'DEU'],
  Munich: [11.58, 48.14, 'DEU'], Nuremberg: [11.08, 49.45, 'DEU'], Frankfurt: [8.68, 50.11, 'DEU'], Kassel: [9.5, 51.32, 'DEU'], Hanover: [9.73, 52.37, 'DEU'],
  Bremen: [8.8, 53.08, 'DEU'], Hamburg: [9.99, 53.55, 'DEU'], Kiel: [10.13, 54.32, 'DEU'], Berlin: [13.4, 52.52, 'DEU'], Stettin: [14.55, 53.43, 'DEU'],
  Danzig: [18.65, 54.35, 'DEU'], Königsberg: [20.51, 54.71, 'DEU'], Posen: [16.93, 52.41, 'DEU'], Breslau: [17.04, 51.11, 'DEU'], Dresden: [13.74, 51.05, 'DEU'],
  Leipzig: [12.37, 51.34, 'DEU'], Verdun: [5.38, 49.16, 'FRA'], Nancy: [6.18, 48.69, 'FRA'], Reims: [4.03, 49.26, 'FRA'], Lille: [3.06, 50.63, 'FRA'],
  Liège: [5.57, 50.63, 'BEL'], Antwerp: [4.4, 51.22, 'BEL'], Vienna: [16.37, 48.21, 'AUT'], Prague: [14.42, 50.08, 'AUT'], Budapest: [19.04, 47.5, 'AUT'],
  Kraków: [19.94, 50.06, 'AUT'], Lemberg: [24.03, 49.84, 'AUT'], Przemyśl: [22.77, 49.78, 'AUT'], Trieste: [13.78, 45.65, 'AUT'], Innsbruck: [11.4, 47.27, 'AUT'],
  Trento: [11.12, 46.07, 'AUT'], Sarajevo: [18.41, 43.86, 'AUT'], Zagreb: [15.98, 45.81, 'AUT'], Czernowitz: [25.94, 48.29, 'AUT'], Warsaw: [21.01, 52.23, 'RUS'],
  Łódź: [19.46, 51.76, 'RUS'], 'Brest-Litovsk': [23.69, 52.1, 'RUS'], Vilna: [25.28, 54.69, 'RUS'], Kovno: [23.9, 54.9, 'RUS'], Riga: [24.1, 56.95, 'RUS'],
  Minsk: [27.56, 53.9, 'RUS'], Kiev: [30.52, 50.45, 'RUS'], Odessa: [30.73, 46.48, 'RUS'], Lublin: [22.57, 51.25, 'RUS'], Tiflis: [44.79, 41.72, 'RUS'],
  Kars: [43.1, 40.6, 'RUS'], Udine: [13.23, 46.06, 'ITA'], Verona: [10.99, 45.44, 'ITA'], Venice: [12.33, 45.44, 'ITA'], Belgrade: [20.46, 44.82, 'SRB'],
  Niš: [21.9, 43.32, 'SRB'], Skopje: [21.43, 42.0, 'SRB'], Sofia: [23.32, 42.7, 'BUL'], Bucharest: [26.1, 44.43, 'ROU'], Salonika: [22.94, 40.64, 'GRC'],
  Constantinople: [28.98, 41.01, 'TUR'], Gallipoli: [26.67, 40.41, 'TUR'], Erzurum: [41.27, 39.9, 'TUR'], Baghdad: [44.37, 33.31, 'TUR'], Basra: [47.81, 30.5, 'TUR'],
  Mosul: [43.13, 36.34, 'TUR'], Aleppo: [37.16, 36.2, 'TUR'], Damascus: [36.29, 33.51, 'TUR'], Jerusalem: [35.22, 31.78, 'TUR'],
};
const inBox = (b, lon, lat) => lon >= b[0] && lat >= b[1] && lon <= b[2] && lat <= b[3];
const theatreOf = (p) => theatres.theatres.find((t) => (!t.iso || t.iso.includes(p.iso)) && (!t.box || inBox(t.box, p.lon, p.lat))
  && (t.coastal === undefined || t.coastal === p.coastal) && (t.desert === undefined || t.desert === (p.terrain === 'desert'))) || theatres.default;
const FRAGMENT_PX = 64;

await section('theatres and parts', () => {
  const fine = land.filter((p) => theatreOf(p).tier === 'fine');
  check(fine.length > 800, `the fine theatres hold several hundred provinces (${fine.length})`);
  eq(fine.filter((p) => p.area > 2 * theatreOf(p).target).map((p) => `${p.name} ${p.area}`), [], 'no fine-theatre province is over twice its target');
  const ownNeighbour = (p) => p.adj.some((q) => !P[q].sea && ownerOf.get(q)[0] === ownerOf.get(p.id)[0]);
  eq(fine.filter((p) => p.area < theatres.minimum && ownNeighbour(p)).map((p) => `${p.name} ${p.area}`), [], `no fine-theatre province is under ${theatres.minimum} km2 beside land of its own nation`);

  const ids = png.ids, n = ids.length, seen = new Uint8Array(n), queue = new Int32Array(n), pieces = new Map();
  for (let s = 0; s < n; s++) {
    const v = ids[s];
    if (!v || P[v].sea || seen[s]) continue;
    seen[s] = 1; queue[0] = s;
    let h = 0, t = 1, touches = false;
    while (h < t) {
      const i = queue[h++], x = i % W;
      for (const j of [x ? i - 1 : i + W - 1, x < W - 1 ? i + 1 : i - W + 1, i >= W ? i - W : -1, i + W < n ? i + W : -1]) {
        if (j < 0) continue;
        const u = ids[j];
        if (u === v) { if (!seen[j]) { seen[j] = 1; queue[t++] = j; } } else if (u && !P[u].sea && ownerOf.get(u)[0] === ownerOf.get(v)[0]) touches = true;
      }
    }
    if (!pieces.has(v)) pieces.set(v, []);
    pieces.get(v).push({ size: t, touches });
  }
  const slivers = [];
  for (const [v, list] of pieces) {
    list.sort((a, b) => b.size - a.size);
    if (list.slice(1).some((c) => c.touches && c.size <= FRAGMENT_PX)) slivers.push(P[v].name);
  }
  eq(slivers.slice(0, 10), [], `every land province is one 4-connected region apart from islands, enclaves in another nation and exclaves over ${FRAGMENT_PX} pixels`);

  const names = new Map(), dup = [];
  for (const p of land) { const key = `${ownerOf.get(p.id)[0]}|${p.name}`; if (names.has(key)) dup.push(key); names.set(key, p.id); }
  eq(dup.slice(0, 10), [], 'province names are unique within a nation');

  const wrong = [];
  let named = 0;
  for (const [name, [lon, lat, want]] of Object.entries(FRONT)) {
    const p = at(lon, lat), got = p ? ownerOf.get(p)?.[0] : 'sea';
    if (got !== want) wrong.push(`${name} ${got} (want ${want})`);
    if (p && P[p].name === name) named++;
  }
  check(Object.keys(FRONT).length >= 40, `the front table holds at least 40 cities (${Object.keys(FRONT).length})`);
  eq(wrong, [], 'every front city lies in a province of its 1914 nation');
  check(named >= Object.keys(FRONT).length * 0.6, `most front cities name their province (${named} of ${Object.keys(FRONT).length})`);

  const front = (a, b) => {
    const sa = new Set(), sb = new Set();
    for (const p of land) if (a.includes(ownerOf.get(p.id)[0])) for (const q of p.adj) if (!P[q].sea && b.includes(ownerOf.get(q)[0])) { sa.add(p.id); sb.add(q); }
    return [sa.size, sb.size];
  };
  for (const [a, b] of [[['DEU'], ['FRA', 'BEL']], [['AUT'], ['RUS']], [['AUT'], ['ITA']], [['AUT'], ['SRB']], [['DEU'], ['RUS']]]) {
    const [x, y] = front(a, b);
    check(x > 0 && y > 0 && Math.max(x, y) <= 1.5 * Math.min(x, y), `front ${a.join('+')} ${x} provinces against ${b.join('+')} ${y}, within a factor of 1.5`);
  }
});

await section('navy, stock and references', () => {
  const items = ['rifles', 'guns', 'heavy', 'mgs', 'shells', 'horses'];
  const whole = (v) => Number.isInteger(v) && v >= 0;
  eq(scenario.nations.filter((n) => !whole(n.navy) || !n.stock || items.some((k) => !whole(n.stock[k]))).map((n) => n.tag), [], 'every nation has a whole navy and a whole stock of every item');
  check(scenario.nations.every((n) => n.tag === 'GBR' || n.navy < nationByTag.get('GBR').navy), 'Britain has the largest navy');
  eq(['DEU', 'USA', 'FRA', 'JPN', 'RUS', 'ITA', 'AUT', 'TUR'].map((t) => nationByTag.get(t).navy).every((v, k, a) => !k || v <= a[k - 1]), true, 'navies rank Germany, the USA, France, Japan, Russia, Italy, Austria-Hungary, the Ottomans');
  eq(scenario.nations.filter((n) => n.navy > 0 && !scenario.owner[n.tag].some((p) => P[p].port)).map((n) => n.tag), [], 'a nation without a port has no navy');
  check(scenario.nations.filter((n) => n.major).every((n) => scenario.nations.filter((m) => !m.major).every((m) => n.stock.rifles > m.stock.rifles)), 'every great power holds more rifles than any minor');

  const owns = (tag, p) => ownerOf.get(p)?.[0] === tag;
  const bad = [];
  for (const n of scenario.nations) for (const g of n.goals) {
    for (const p of g.provinces || []) if (!P[p] || P[p].sea) bad.push(`${n.tag} ${g.id}: ${p} is not land`);
    if (g.kind === 'hold' && !g.provinces.every((p) => owns(n.tag, p))) bad.push(`${n.tag} holds ${g.id} without owning it`);
    if ((g.kind === 'take' || g.kind === 'join') && g.provinces?.length && g.provinces.every((p) => owns(n.tag, p))) bad.push(`${n.tag} wants ${g.id} it already owns`);
  }
  for (const id of Object.keys(scenario.provinces)) if (!P[id] || P[id].sea) bad.push(`economy of ${id}`);
  for (const [t, list] of Object.entries(scenario.cores)) if (!list.length || !list.some((p) => owns(t, p))) bad.push(`cores of ${t}`);
  for (const a of scenario.armies) if (!a.at.length) bad.push(`army ${a.name} stands nowhere`);
  eq(bad.slice(0, 10), [], 'goals, economy, cores and armies name land provinces owned as they imply');
});

await section('europe picture', () => {
  const x0 = Math.floor((-11 + 180) * PPD), x1 = Math.floor((50 + 180) * PPD), y0 = Math.floor((90 - 62) * PPD), y1 = Math.floor((90 - 28) * PPD);
  const w = x1 - x0, h = y1 - y0, rgb = Buffer.alloc(w * h * 3);
  const colour = new Map(scenario.nations.map((n) => [n.tag, [1, 3, 5].map((k) => parseInt(n.color.slice(k, k + 2), 16))]));
  const isLand = (v) => v && !P[v].sea;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y0 + y) * W + x0 + x, v = png.ids[i];
    let c = !v ? [16, 20, 24] : P[v].sea ? [30, 56, 90] : colour.get(ownerOf.get(v)[0]);
    const r = png.ids[i + 1], d = png.ids[i + W];
    if (isLand(v) && ((isLand(r) && r !== v) || (isLand(d) && d !== v))) {
      const u = isLand(r) && r !== v ? r : d;
      c = c.map((k) => Math.round(k * (ownerOf.get(u)[0] !== ownerOf.get(v)[0] ? 0.25 : 0.65)));
    }
    rgb.set(c, (y * w + x) * 3);
  }
  const put = (x, y, c) => { if (x >= 0 && y >= 0 && x < w && y < h) rgb.set(c, (y * w + x) * 3); };
  for (const [name, [lon, lat]] of Object.entries(FRONT)) {
    const cx = Math.floor((lon + 180) * PPD) - x0, cy = Math.floor((90 - lat) * PPD) - y0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) put(cx + dx, cy + dy, dx || dy ? [0, 0, 0] : [255, 255, 255]);
    const text = name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[Łł]/g, 'L').toUpperCase();
    const ink = (ox, oy, c) => [...text].forEach((ch, k) => (GLYPHS[ch] || GLYPHS[' ']).forEach((row, gy) => [...row].forEach((bit, gx) => {
      if (bit === '#') put(ox + k * 6 + gx, oy + gy, c);
    })));
    for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) ink(cx + 4 + ox, cy - 3 + oy, [0, 0, 0]);
    ink(cx + 4, cy - 3, [255, 255, 255]);
  }
  const out = path.join(ROOT, 'verify/out/conquest-europe-1914.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, encodePng(w, h, rgb));
  check(fs.statSync(out).size > 0, `wrote ${path.relative(ROOT, out)} (${w}x${h})`);
});

await section('sizes and rebuild', () => {
  const size = (f) => fs.statSync(path.join(DATA, f)).size;
  check(size('map.json') < 2.5e6, `map.json under 2.5 MB (${(size('map.json') / 1e6).toFixed(2)} MB)`);
  check(size('ids.png') < 3e6, `ids.png under 3 MB (${(size('ids.png') / 1e6).toFixed(2)} MB)`);
  check(size('scenario.json') < 1e6, `scenario.json under 1 MB (${(size('scenario.json') / 1e6).toFixed(2)} MB)`);
  if (!fs.existsSync(path.join(SRC, 'ne_10m_admin_1_states_provinces.geojson'))) {
    console.log('note: Natural Earth sources not in verify/out/downloads-cache/natural-earth; the rebuild check is skipped');
    return;
  }
  const out = path.join(ROOT, 'verify/out/conquest-maps-rebuild');
  fs.rmSync(out, { recursive: true, force: true });
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools/build-conquest-maps.mjs'), '--src', SRC, '--out', out, '--quiet'], { stdio: 'inherit' });
    for (const f of ['map.json', 'ids.png', 'scenario.json']) check(fs.readFileSync(path.join(out, f)).equals(fs.readFileSync(path.join(DATA, f))), `a rebuild gives the committed ${f} byte for byte`);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

const failedCount = results.filter((r) => !r.ok).length;
console.log(`${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount ? 1 : 0);
