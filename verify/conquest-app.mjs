// Nano Studio Conquest (renderer/features/conquest, main/features/conquest.js): --mode=conquest opens the game's window
// on its own workspace (PYIDE_CONQUEST_HOME) with the IDE chrome hidden and the WebGL map drawn; real mouse events on a
// province's anchor select that province (also beside a border, on a small island, after wheel zoom and drag pan), and
// the GPU draws the selection where the click was; the map modes change the pixels; keyboard zoom, a lost and restored
// WebGL context, counters and arrows on the overlay; the save, load, list and worker source channels; the start
// chooser's fourth card opens Conquest; --mode=code and --mode=craft load no Conquest code; Korean strings. The map is
// the one behind the start screen (no game running): clicks go only where the map is not covered by the start card.
// The game itself (worker, commands, saves) is verify/conquest-game.mjs.
// Screenshots verify/out/conquest-map-dark.png and conquest-map-light.png. Ports 9830-9833.
import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, attachPage, tempDir } from './lib.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const OUT = path.join(APP_DIR, 'verify', 'out');
const PRODUCT = JSON.parse(readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).productName;
const S = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const errors = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const same = (a, b) => S(a) === S(b);
const done = (ctx, label) => {
  if (ctx.consoleErrors.length) errors.push(`${label}: ${ctx.consoleErrors.join(' | ')}`);
  if (ctx.cspViolations.length) errors.push(`${label} CSP: ${ctx.cspViolations.join(' | ')}`);
  ctx.close();
};

const V = 'Conquest.app.view';
// Whether the map, not the start card over it, is at a point of the map (CSS pixels in the map).
const ON_MAP = `((x, y) => { const r = document.querySelector('.cq-map').getBoundingClientRect(); return !!document.elementFromPoint(r.left + x, r.top + y)?.closest('.cq-map'); })`;
// Page coordinates of a texture point, from the stage's box and the view's camera.
const pagePoint = (ctx, mx, my) => ctx.js(`(() => { const r = document.querySelector('.cq-map').getBoundingClientRect(); const [x, y] = ${V}.camera.toScreen(${mx}, ${my}); return { x: r.left + x, y: r.top + y, lx: x, ly: y, inside: x >= 0 && y >= 0 && x < r.width && y < r.height }; })()`);
const sample = (ctx, pts) => ctx.js(`${V}.sample(${S(pts.map((p) => [p.lx, p.ly]))})`);
const mouse = (ctx, type, x, y, extra = {}) => ctx.cdp('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1, ...extra });
async function clickAt(ctx, p) {
  await mouse(ctx, 'mouseMoved', p.x, p.y);
  await sleep(40);
  await mouse(ctx, 'mousePressed', p.x, p.y, { buttons: 1 });
  await mouse(ctx, 'mouseReleased', p.x, p.y, { buttons: 0 });
  await sleep(120);
}
async function selectAt(ctx, mx, my) {
  const p = await pagePoint(ctx, mx, my);
  await clickAt(ctx, p);
  return { p, selected: await ctx.js(`${V}.selected`), event: await ctx.js(`window.__cqSelects.at(-1)`) };
}

const home = path.join(tempDir('conquest-app'), 'Conquest Home');
const env = { PYIDE_CONQUEST_HOME: home };

try {
  // ---------- --mode=conquest ----------
  {
    const ctx = await launch({ fixture: 'core', port: 9830, name: 'conquest-app', mode: 'conquest', env });
    const { js, until } = ctx;
    const s = await js(`(() => {
      const shown = (id) => { const n = document.getElementById(id); return !!n && getComputedStyle(n).display !== 'none' && n.getClientRects().length > 0; };
      const host = document.getElementById('conquestHost').getBoundingClientRect();
      return { mode: ide.appMode, root: ide.root, trusted: ide.trusted, title: document.title, app: document.body.classList.contains('app-conquest'),
        hidden: ['toolbar', 'runWidget', 'stripe', 'stripeRight', 'sidePanel', 'editorArea', 'bottom', 'craftHost', 'cutHost', 'statusPath'].filter(shown),
        host: { x: host.x, y: host.y, w: host.width, h: host.height }, win: innerWidth, scripts: [...document.querySelectorAll('script[data-plugin]')].map((n) => n.dataset.plugin) };
    })()`);
    check(s.mode === 'conquest' && s.app && s.title === `${PRODUCT} Conquest`, `--mode=conquest opens the Conquest window (${S({ mode: s.mode, title: s.title })})`);
    check(existsSync(home) && s.root?.toLowerCase() === home.toLowerCase() && s.trusted, `the Conquest workspace is created and opened as the project (${S({ root: s.root, trusted: s.trusted })})`);
    check(!s.hidden.length && s.host.x === 0 && s.host.y === 0 && Math.abs(s.host.w - s.win) <= 1 && s.host.h > 300, `the game fills the window and the IDE chrome is hidden (${S({ hidden: s.hidden, host: s.host })})`);
    check(s.scripts.includes('conquest') && !['vcs', 'minecraft', 'cut', 'lsp'].some((p) => s.scripts.includes(p)), `conquest mode loads its plugin, not Code's, Craft's or Cut's (${S(s.scripts)})`);
    await until('window.__conquestReady === true', 'the first map frame', 60000);
    await js(`(window.__cqSelects = [], ${V}.on('select', (e) => window.__cqSelects.push(e.id)), true)`);
    const info = await js(`({ source: Conquest.app.source, gl: ${V}.info, n: ${V}.map.provinces.length - 1, w: ${V}.map.texture.width, h: ${V}.map.texture.height, scale: ${V}.camera.scale })`);
    console.log(`map: ${info.source}, ${info.n} provinces, ${info.w}x${info.h}; GPU ${info.gl?.renderer} (max texture ${info.gl?.maxTexture})`);
    const grid = [];
    for (let i = 1; i < 6; i++) for (let j = 1; j < 6; j++) grid.push(await js(`(() => { const c = ${V}.camera; return { lx: c.w * ${i} / 6, ly: c.h * ${j} / 6 }; })()`));
    const px = await sample(ctx, grid);
    const colours = new Set(px.map((c) => c.join()));
    check(colours.size >= 4, `the map has drawn: ${colours.size} different colours at 25 points`);
    const bar = await js(`[...document.querySelectorAll('.cq-mode')].map((b) => ({ mode: b.dataset.mode, text: b.textContent, on: b.classList.contains('active') }))`);
    check(same(bar.map((b) => b.mode), ['political', 'terrain', 'supply', 'weather', 'diplomacy']) && bar[0].on && same(bar.map((b) => b.text), ['Political', 'Terrain', 'Supply', 'Weather', 'Diplomacy']),
      `the top bar offers the five map modes, political on (${S(bar.map((b) => b.text))})`);

    // Land provinces to click: the anchors on screen, the island, and two of different owners.
    const land = await js(`(() => {
      const m = ${V}.map; const c = ${V}.camera; const out = [];
      for (const p of m.provinces) { if (!p || p.sea) continue; const [x, y] = c.toScreen(p.x, p.y); if (x > 40 && y > 40 && x < c.w - 40 && y < c.h - 40 && ${ON_MAP}(x, y)) out.push({ id: p.id, x: p.x, y: p.y, area: p.area, island: p.adj.every((a) => m.provinces[a]?.sea) }); }
      return out;
    })()`);
    const picks = land.filter((p) => !p.island).filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 6)) === 0).slice(0, 6);
    const hits = [];
    for (const p of picks) {
      const r = await selectAt(ctx, p.x + 0.5, p.y + 0.5);
      hits.push({ id: p.id, selected: r.selected, event: r.event });
    }
    check(hits.length >= 4 && hits.every((h) => h.selected === h.id && h.event === h.id), `a click on a province's anchor selects that province, at the whole-map zoom (${S(hits)})`);

    const island = land.filter((p) => p.island).sort((a, b) => a.area - b.area)[0];
    if (island) {
      const r = await selectAt(ctx, island.x + 0.5, island.y + 0.5);
      const radius = await js(`Math.sqrt(${island.area} / Math.PI) / (40075 / ${V}.map.texture.width) * ${V}.camera.scale`);
      check(r.selected === island.id, `a click on a small island (about ${radius.toFixed(1)} px across on screen) selects it (${r.selected} for ${island.id})`);
    } else check(false, 'the map has a land province on screen with only sea around it');

    // The GPU draws the selection where the click was: beside a border, zoomed in on one province.
    const a = picks[1];
    await js(`(${V}.setSelected(0), ${V}.focus(${a.id}), ${V}.zoom(3), true)`);
    await sleep(200);
    const edge = await js(`(() => {
      const v = ${V}; const at = (x, y) => v.provinceAt(...v.camera.toScreen(x + 0.5, y + 0.5));
      for (let x = ${Math.floor(a.x)}; x < ${Math.floor(a.x)} + 400; x++) { const b = at(x + 1, ${Math.floor(a.y)}); if (b !== ${a.id}) return { x, y: ${Math.floor(a.y)}, b, mine: at(x, ${Math.floor(a.y)}) }; }
      return null;
    })()`);
    if (edge && edge.mine === a.id) {
      const pa = await pagePoint(ctx, edge.x + 0.5, edge.y + 0.5);
      const pb = await pagePoint(ctx, edge.x + 1.5, edge.y + 0.5);
      await mouse(ctx, 'mouseMoved', pa.x, pa.y);
      await sleep(80);
      const before = await sample(ctx, [pa, pb]);
      const r = await selectAt(ctx, edge.x + 0.5, edge.y + 0.5);
      const after = await sample(ctx, [pa, pb]);
      const scale = await js(`${V}.camera.scale`);
      check(r.selected === a.id, `a click ${(scale / 2).toFixed(1)} px inside a border selects the province on that side (${r.selected}, expected ${a.id}, ${edge.b} across)`);
      check(!same(before[0], after[0]) && same(before[1], after[1]), `the GPU draws the selection on the clicked side only (${S({ before, after })})`);
      const rb = await selectAt(ctx, edge.x + 1.5, edge.y + 0.5);
      check(rb.selected === edge.b, `one texture pixel further, across the border, selects the neighbour (${rb.selected}, expected ${edge.b})`);
    } else check(false, `found a border beside province ${a.id} (${S(edge)})`);

    // Real wheel zoom about the cursor and a real right drag (the left drag selects in a game, ui/selectbox.js), then a click on what is under the cursor.
    await js(`(${V}.camera.fit(), ${V}.redraw(), true)`);
    await sleep(150);
    const target = await js(`(() => { const c = ${V}.camera; const d = (p) => Math.hypot(c.toScreen(p.x, p.y)[0] - c.w / 2, c.toScreen(p.x, p.y)[1] - c.h / 2);
      return ${V}.map.provinces.filter((p) => p && !p.sea).sort((a, b) => d(a) - d(b))[0]; })()`);
    const before = await js(`({ ...${V}.camera, toScreen: 0, toMap: 0 })`);
    const wp = await pagePoint(ctx, target.x, target.y);
    // Chromium delivers the pointer at whole CSS pixels: the point that must stay is the one under that pixel.
    wp.x = Math.round(wp.x);
    wp.y = Math.round(wp.y);
    const under = await js(`(() => { const r = document.querySelector('.cq-map').getBoundingClientRect(); return { lx: ${wp.x} - r.left, ly: ${wp.y} - r.top, m: ${V}.camera.toMap(${wp.x} - r.left, ${wp.y} - r.top) }; })()`);
    for (let i = 0; i < 6; i++) { await mouse(ctx, 'mouseWheel', wp.x, wp.y, { deltaX: 0, deltaY: -240 }); await sleep(30); }
    await sleep(150);
    const zoomed = await js(`({ scale: ${V}.camera.scale, at: ${V}.camera.toScreen(${under.m[0]}, ${under.m[1]}) })`);
    check(zoomed.scale > before.scale * 3 && Math.abs(zoomed.at[0] - under.lx) < 0.5 && Math.abs(zoomed.at[1] - under.ly) < 0.5, `the wheel zooms in about the cursor (${before.scale.toFixed(3)} -> ${zoomed.scale.toFixed(3)}, the point under it stays at ${zoomed.at.map((v) => v.toFixed(1))} for ${under.lx.toFixed(1)},${under.ly.toFixed(1)})`);
    const selectsBefore = await js('window.__cqSelects.length');
    const camBefore = await js(`[${V}.camera.x, ${V}.camera.y]`);
    await mouse(ctx, 'mouseMoved', wp.x, wp.y);
    await mouse(ctx, 'mousePressed', wp.x, wp.y, { button: 'right', buttons: 2 });
    for (let i = 1; i <= 10; i++) await mouse(ctx, 'mouseMoved', wp.x - i * 15, wp.y - i * 8, { button: 'right', buttons: 2 });
    await mouse(ctx, 'mouseReleased', wp.x - 150, wp.y - 80, { button: 'right', buttons: 0 });
    await sleep(150);
    const camAfter = await js(`[${V}.camera.x, ${V}.camera.y, ${V}.camera.scale]`);
    const moved = [(camAfter[0] - camBefore[0]) * camAfter[2], (camAfter[1] - camBefore[1]) * camAfter[2]];
    check(Math.abs(moved[0] - 150) < 2 && Math.abs(moved[1] - 80) < 2 && (await js('window.__cqSelects.length')) === selectsBefore, `a right drag pans the map with the pointer and selects nothing (${moved.map((v) => v.toFixed(1))} px)`);
    const visible = await js(`(() => { const c = ${V}.camera; return ${V}.map.provinces.filter((p) => p && !p.sea).map((p) => ({ id: p.id, x: p.x, y: p.y, s: c.toScreen(p.x, p.y) })).filter((p) => p.s[0] > 60 && p.s[1] > 60 && p.s[0] < c.w - 60 && p.s[1] < c.h - 60 && ${ON_MAP}(p.s[0], p.s[1])).slice(0, 3); })()`);
    const zoomHits = [];
    for (const p of visible) zoomHits.push({ id: p.id, got: (await selectAt(ctx, p.x + 0.5, p.y + 0.5)).selected });
    check(zoomHits.length >= 2 && zoomHits.every((h) => h.got === h.id), `after zooming and panning a click on an anchor selects that province (${S(zoomHits)})`);

    // Keyboard zoom through the registered actions (+ and - set the game speed).
    const k0 = await js(`${V}.camera.scale`);
    await ctx.press('PageUp');
    await sleep(80);
    const k1 = await js(`${V}.camera.scale`);
    await ctx.press('PageDown');
    await ctx.press('PageDown');
    await sleep(80);
    const k2 = await js(`${V}.camera.scale`);
    check(k1 > k0 * 1.3 && k2 < k1 / 1.8, `PageUp zooms in and PageDown zooms out (${[k0, k1, k2].map((v) => v.toFixed(3))})`);

    // Map modes change the pixels; the neutral ones draw two nations alike.
    await js(`(${V}.setSelected(0), ${V}.camera.centerOn(${picks[0].x}, ${picks[0].y}, 1), ${V}.redraw(), true)`);
    await sleep(150);
    // Anchors with the same province 5 px around them, so no border line is sampled.
    const anchors = await js(`(() => { const v = ${V}; const c = v.camera;
      const clear = (p) => { const [x, y] = c.toScreen(p.x + 0.5, p.y + 0.5); return x > 10 && y > 10 && x < c.w - 10 && y < c.h - 10 && ${ON_MAP}(x, y) && [[0, 0], [5, 0], [-5, 0], [0, 5], [0, -5], [4, 4], [-4, -4], [4, -4], [-4, 4]].every(([dx, dy]) => v.provinceAt(x + dx, y + dy) === p.id); };
      return v.map.provinces.filter((p) => p && !p.sea && clear(p)).map((p) => ({ x: p.x, y: p.y })); })()`);
    const pts = [];
    for (const p of anchors.filter((_, i) => i % Math.max(1, Math.floor(anchors.length / 40)) === 0).slice(0, 40)) pts.push(await pagePoint(ctx, p.x + 0.5, p.y + 0.5));
    const political = await sample(ctx, pts);
    const { click } = ctx;
    await click('.cq-mode[data-mode="terrain"]');
    await sleep(150);
    const terrain = await sample(ctx, pts);
    const terrainOn = await js(`${V}.mode === 'terrain' && document.querySelector('.cq-mode[data-mode="terrain"]').classList.contains('active')`);
    check(terrainOn && political.some((c, i) => !same(c, terrain[i])), `the Terrain button switches the map mode and changes the pixels (${political.filter((c, i) => !same(c, terrain[i])).length}/${pts.length} changed)`);
    await click('.cq-mode[data-mode="supply"]');
    await sleep(150);
    const supply = await sample(ctx, pts);
    check(new Set(political.map((c) => c.join())).size > 2 && new Set(supply.map((c) => c.join())).size === 1, `the supply mode draws every land province neutral for now (${new Set(supply.map((c) => c.join())).size} colour)`);
    await click('.cq-mode[data-mode="political"]');
    await sleep(150);
    check(same(await sample(ctx, pts), political), 'back to political, the map is drawn as before');

    // Counters (in the map's WebGL context, in the nation's colour), fronts and arrows (on the overlay).
    const ov = await js(`(() => {
      const v = ${V}; const c = v.camera; const d = devicePixelRatio;
      const ps = [];
      for (const p of v.map.provinces) {
        if (!p || p.sea || ps.length >= 12) continue;
        const [x, y] = c.toScreen(p.x, p.y);
        if (x > 30 && y > 30 && x < c.w - 30 && y < c.h - 30 && ${ON_MAP}(x, y) && ps.every((q) => { const [qx, qy] = c.toScreen(q.x, q.y); return Math.abs(qx - x) > 40 || Math.abs(qy - y) > 30; })) ps.push(p);
      }
      const colors = ['#ff00ff', '#00e5ff', '#ffee00'];
      // Along the top of the box, inside its frame and above the symbol and the number.
      const { W, H, PAD } = Conquest.view.COUNTER;
      const SPOTS = [[PAD + 6, PAD + 1.6], [PAD + 12, PAD + 1.6], [PAD + 17, PAD + 1.6], [PAD + 22, PAD + 1.6], [PAD + 1.6, PAD + 6]];
      const spots = (p) => { const [x, y] = c.toScreen(p.x + 0.5, p.y + 0.5); const x0 = Math.floor(x * d - Math.ceil((W + 2 * PAD) * d) / 2) / d; const y0 = Math.floor(y * d - Math.ceil((H + 2 * PAD) * d) / 2) / d; return SPOTS.map(([a, b]) => [x0 + a, y0 + b]); };
      const bare = ps.map((p) => v.sample(spots(p)));
      v.setUnits(ps.map((p, i) => ({ prov: p.id, nation: i % 3, count: 1 + i, color: colors[i % 3] })));
      v.setFronts([{ provinces: ps.slice(0, 4).map((p) => p.id), color: '#ffffff' }]);
      v.setArrows([{ path: ps.slice(4, 8).map((p) => p.id), color: '#d33c2f' }]);
      const drawn = ps.map((p) => v.sample(spots(p)));
      const want = ps.map((p, i) => [1, 3, 5].map((k) => parseInt(colors[i % 3].slice(k, k + 2), 16)));
      const g = document.querySelector('.cq-map-overlay').getContext('2d');
      let ink = 0; const o = g.getImageData(0, 0, g.canvas.width, g.canvas.height).data; for (let i = 3; i < o.length; i += 4) if (o[i]) ink++;
      return { n: ps.length, ok: drawn.map((pxs, i) => pxs.some((px, j) => px.every((v, k) => Math.abs(v - want[i][k]) <= 2) && !px.every((v, k) => v === bare[i][j][k]))), drawn: drawn.map((pxs) => pxs[0]), ink };
    })()`);
    check(ov.n >= 8 && ov.ok.every(Boolean), `a division counter in its nation's colour is drawn at each province anchor it was set for (${S(ov.ok)} ${S(ov.drawn.slice(0, 3))})`);
    check(ov.ink > 500, `the front and the arrow are drawn on the overlay (${ov.ink} pixels)`);

    // A lost WebGL context is rebuilt when the browser gives it back.
    const kept = await sample(ctx, pts.slice(0, 8));
    await js(`(window.__lose = ${V}.info && document.querySelector('.cq-map-gl').getContext('webgl2').getExtension('WEBGL_lose_context'), window.__lose.loseContext(), true)`);
    await until(`${V}.lost`, 'the context is lost', 5000);
    await js(`(window.__lose.restoreContext(), true)`);
    await until(`!${V}.lost`, 'the context is restored', 10000);
    await sleep(200);
    check(same(await sample(ctx, pts.slice(0, 8)), kept), 'after a lost and restored WebGL context the map draws as before');

    // Nation names across their land, fading out zoomed in; names take no clicks.
    await js(`(${V}.setUnits([]), ${V}.setFronts([]), ${V}.setArrows([]), ${V}.setSelected(0), ${V}.camera.fit(), true)`);
    const ink = `((x, y, w, h) => { const d = devicePixelRatio; const g = document.querySelector('.cq-map-overlay').getContext('2d'); ${V}.sample([[1, 1]]);
      const o = g.getImageData(Math.round((x - w / 2) * d), Math.round((y - h / 2) * d), Math.round(w * d), Math.round(h * d)).data; let n = 0; for (let i = 3; i < o.length; i += 4) if (o[i]) n++; return n; })`;
    const fra = await js(`(() => { const v = ${V}; const c = v.camera; const l = v.labels.find((x) => x.text === 'France' && x.main); if (!l) return null;
      const at = (x, y) => v.map.provinces[v.provinceAt(...c.toScreen(x, y))];
      for (const [fx, fy] of [[0.5, 0.5], [0.7, 0.5], [0.3, 0.5], [0.5, 0.7], [0.5, 0.3], [0.8, 0.75], [0.2, 0.25]]) {
        c.scale = 0.9; c.x = l.x - c.w * fx / c.scale; c.y = l.y - c.h * fy / c.scale; c.clamp(); const [sx, sy] = c.toScreen(l.x, l.y);
        if (${ON_MAP}(sx, sy)) return { l, sx, sy, under: at(l.x, l.y)?.iso, alpha: v.labelAlpha, ink: ${ink}(sx, sy, 40, 12), names: v.labels.length };
      }
      return { l, covered: true }; })()`);
    check(fra && !fra.covered && fra.under === 'FRA' && fra.alpha === 1 && fra.ink > 20 && fra.names >= 40,
      `the name France is written over French land when zoomed out (${S(fra && { names: fra.names, under: fra.under, alpha: fra.alpha, ink: fra.ink, size: fra.l?.size, angle: fra.l?.angle })})`);
    if (fra && !fra.covered) {
      const under = await js(`${V}.provinceAt(${fra.sx}, ${fra.sy})`);
      const r = await selectAt(ctx, fra.l.x, fra.l.y);
      check(under > 0 && r.selected === under, `a click on the name selects the province under it (${r.selected}, expected ${under})`);
      const zin = await js(`(() => { const v = ${V}; v.setSelected(0); v.camera.centerOn(${fra.l.x}, ${fra.l.y}, 4); const [x, y] = v.camera.toScreen(${fra.l.x}, ${fra.l.y}); return { alpha: v.labelAlpha, ink: ${ink}(x, y, 40, 12) }; })()`);
      check(zin.alpha === 0 && zin.ink === 0, `zoomed in where counters matter, the names are hidden (${S(zin)})`);
    }

    // The real edge between two provinces, from the id raster.
    const edge2 = await js(`(() => { const v = ${V}; const P = v.map.provinces; const c = v.camera;
      const at = (x, y) => v.provinceAt(...c.toScreen(x, y));
      const pairs = []; for (const p of P) { if (!p || p.sea || p.iso !== 'FRA') continue; for (const q of p.adj) if (!P[q].sea && P[q].iso !== 'FRA') pairs.push([p.id, q]); }
      const out = { pairs: pairs.length, vertices: 0, bad: [], empty: 0 };
      for (const [a, b] of pairs.slice(0, 12)) { const e = v.edge(a, b); if (!e.length) out.empty++;
        for (const path of e) for (let i = 0; i < path.length; i += 2) { const x = path[i], y = path[i + 1]; out.vertices++;
          const s = new Set([at(x - 0.5, y - 0.5), at(x + 0.5, y - 0.5), at(x - 0.5, y + 0.5), at(x + 0.5, y + 0.5)]); if (!s.has(a) || !s.has(b)) out.bad.push([a, b, x, y]); } }
      return out; })()`);
    check(edge2.pairs >= 6 && !edge2.empty && edge2.vertices > 20 && !edge2.bad.length, `the edge of two provinces from the id raster lies on their shared border (${S({ ...edge2, bad: edge2.bad.slice(0, 4) })})`);

    // Stacks of one nation in neighbouring provinces merge zoomed out and split zoomed in, keeping their total.
    const merge = await js(`(() => { const v = ${V}; const P = v.map.provinces; const c = v.camera;
      const fr = P.filter((p) => p && !p.sea && p.iso === 'FRA').slice(0, 40);
      v.setUnits(fr.map((p, i) => ({ prov: p.id, nation: 0, count: 1 + (i % 4), color: '#3366cc', key: 'fr', str: 0.8, org: 0.6 })));
      const total = (list) => list.reduce((n, k) => n + k.count, 0);
      const cx = fr.reduce((s, p) => s + p.x, 0) / fr.length; const cy = fr.reduce((s, p) => s + p.y, 0) / fr.length;
      c.centerOn(cx, cy, 0.5); const out = c.scale; const far = v.counters().map((k) => ({ lead: k.lead, members: k.members.join(), count: k.count }));
      c.pan(60, 35); const panned = v.counters().map((k) => ({ lead: k.lead, members: k.members.join(), count: k.count }));
      c.centerOn(cx, cy, 12); const near = v.counters();
      const r = { units: fr.length, sum: total(fr.map((p, i) => ({ count: 1 + (i % 4) }))), far: far.length, farSum: total(far), near: near.length, nearSum: total(near), stable: JSON.stringify(far) === JSON.stringify(panned), scale: out };
      v.setUnits([]); return r; })()`);
    check(merge.far < merge.units / 2 && merge.near === merge.units && merge.farSum === merge.sum && merge.nearSum === merge.sum && merge.stable,
      `zoomed out, neighbouring stacks of one nation merge into fewer counters with the same total, stay put while panning, and split zoomed in (${S(merge)})`);

    // Main's channels: saves, the worker source, data.
    const io = await js(`(async () => {
      const inv = (...a) => ide.api.invoke(...a);
      const saved = await inv('conquest:save', 'Test Save 1', '{"v":1,"hour":24}');
      const again = await inv('conquest:save', 'Test Save 1', '{"v":1,"hour":48}');
      const list = await inv('conquest:list');
      const load = await inv('conquest:load', 'Test Save 1');
      const bad = await inv('conquest:save', '../escape', 'x');
      const missing = await inv('conquest:load', 'No Such Save');
      const worker = await inv('conquest:workerSource');
      const data = await inv('conquest:data', '../plugin.json');
      return { saved, again, list, load, bad, missing, worker: { ok: worker.ok, code: worker.code, files: worker.files, length: worker.text?.length }, data };
    })()`);
    const saveFile = path.join(home, 'Saves', 'Test Save 1.ncq');
    check(io.saved.ok && io.again.ok && existsSync(saveFile) && readFileSync(saveFile, 'utf8') === '{"v":1,"hour":48}', `conquest:save writes <home>\\Saves\\<name>.ncq and replaces it (${S(io.saved)})`);
    check(io.list.ok && io.list.items.length === 1 && io.list.items[0].name === 'Test Save 1' && io.load.ok && io.load.text === '{"v":1,"hour":48}', `conquest:list and conquest:load find it (${S(io.list.items)})`);
    check(io.bad.code === 'badName' && io.missing.code === 'missing' && io.data.code === 'invalid', `bad names and paths come back as codes, not throws (${S([io.bad.code, io.missing.code, io.data.code])})`);
    const simDir = path.join(APP_DIR, 'renderer', 'features', 'conquest', 'sim');
    if (existsSync(path.join(simDir, 'modules.json'))) {
      const list = JSON.parse(readFileSync(path.join(simDir, 'modules.json'), 'utf8'));
      const files = Array.isArray(list) ? list : list.files;
      const length = files.reduce((n, f) => n + readFileSync(path.join(simDir, ...f.split('/')), 'utf8').length, 0);
      check(io.worker.ok && same(io.worker.files, files) && io.worker.length >= length, `conquest:workerSource joins the ${files.length} files of sim/modules.json in order (${io.worker.length} characters)`);
    } else check(!io.worker.ok && io.worker.code === 'missing', `with no sim/modules.json conquest:workerSource says missing (${S(io.worker)})`);

    // Both themes.
    await js(`(${V}.camera.fit(), ${V}.redraw(), ${V}.setSelected(${picks[0].id}), true)`);
    await sleep(300);
    const shoot = async (file) => { const r = await ctx.cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(OUT, file), Buffer.from(r.result.data, 'base64')); return path.join(OUT, file); };
    const contrast = () => js(`(() => { const lum = (c) => { const [r, g, b] = c.match(/\\d+/g).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const bar = getComputedStyle(document.querySelector('.cq-bar')).backgroundColor; const t = getComputedStyle(document.querySelector('.cq-title')).color;
      const m = getComputedStyle(document.querySelector('.cq-mode:not(.active)')).color; return { bar: lum(bar), title: lum(t), mode: lum(m) }; })()`);
    const dark = await contrast();
    console.log(`screenshot: ${await shoot('conquest-map-dark.png')}`);
    await js(`(ide.settings.set('appearance.theme', 'light'), true)`);
    await until(`document.documentElement.dataset.theme === 'light'`, 'the light theme', 5000);
    await sleep(400);
    const light = await contrast();
    console.log(`screenshot: ${await shoot('conquest-map-light.png')}`);
    check(dark.bar < 80 && light.bar > 180 && Math.abs(dark.title - dark.bar) > 100 && Math.abs(light.title - light.bar) > 100 && Math.abs(light.mode - light.bar) > 60,
      `the top bar reads in dark and light (${S({ dark, light })})`);
    await js(`(ide.settings.set('appearance.theme', 'dark'), true)`);
    done(ctx, 'conquest');
  }

  // ---------- Korean ----------
  {
    const ctx = await launch({ fixture: 'core', port: 9830, name: 'conquest-app-ko', mode: 'conquest', lang: 'ko-KR', env });
    await ctx.until('window.__conquestReady === true', 'the map in Korean', 60000);
    const kl = await ctx.js(`(() => { const l = ${V}.labels.find((x) => x.text === tr('France')); const g = new OffscreenCanvas(4, 4).getContext('2d');
      g.font = '600 40px ' + getComputedStyle(document.querySelector('.cq-map')).fontFamily; const w = g.measureText('프랑스').width; g.font = '600 40px monospace';
      return { text: l?.text, size: l?.size, width: w, mono: g.measureText('프랑스').width, family: getComputedStyle(document.querySelector('.cq-map')).fontFamily }; })()`);
    check(kl.text === '프랑스' && kl.size > 0 && kl.width > 60, `the map writes nation names in Korean with a font that has Hangul (${S(kl)})`);
    const ko = await ctx.js(`({ modes: [...document.querySelectorAll('.cq-mode')].map((b) => b.textContent), chooser: tr('Lead a nation through the Great War'),
      zoom: ide.actions.find((a) => a.id === 'Conquest.ZoomIn')?.title, source: document.querySelector('.cq-source').textContent, gen: Conquest.app.source })`);
    check(same(ko.modes, ['정치', '지형', '보급', '날씨', '외교']) && ko.zoom === '지도 확대' && ko.chooser === '1차 세계 대전의 나라 이끌기' && (ko.gen !== 'generated' || ko.source === '생성한 지도'),
      `Conquest speaks Korean (${S(ko)})`);
    done(ctx, 'korean');
  }

  // ---------- the start chooser's fourth card ----------
  {
    const port = 9831;
    const data = path.join(tempDir('conquest-app-chooser'), 'userdata');
    const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${port}`, '--lang=en-US'], {
      env: { PYIDE_SEMANTIC_BACKEND: 'fake', PYIDE_AI_COMPLETE_BACKEND: 'fake', ...process.env, PYIDE_USER_DATA: data, PYIDE_CONQUEST_HOME: path.join(tempDir('conquest-app-home2'), 'Home') },
      stdio: 'ignore',
    });
    try {
      const ch = await attachPage(port, (t) => /\/renderer\/chooser\.html/.test(t.url), 30000);
      const cjs = async (expr) => (await ch.cdp('Runtime.evaluate', { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true })).result?.result?.value;
      for (let end = Date.now() + 15000; Date.now() < end && !(await cjs(`document.querySelectorAll('.chooser-card .chooser-name')[3]?.textContent`)); await sleep(150));
      const cards = await cjs(`[...document.querySelectorAll('.chooser-card')].map((n) => ({ mode: n.dataset.mode, name: n.querySelector('.chooser-name').textContent, sub: n.querySelector('.chooser-sub').textContent, icon: !!n.querySelector('svg') }))`);
      check(cards.length === 4 && cards[3].mode === 'conquest' && cards[3].name === `${PRODUCT} Conquest` && cards[3].sub === 'Lead a nation through the Great War' && cards.every((c) => c.icon),
        `the chooser shows four cards, the fourth Conquest with its icon (${S(cards.map((c) => c.name))})`);
      const box = await cjs(`(() => { const r = document.getElementById('chooseConquest').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await ch.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
      await sleep(300);
      const grown = await cjs(`(() => { const r = document.getElementById('chooseConquest').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await ch.click(grown.x, grown.y);
      const ide = await attachPage(port, (t) => /\/renderer\/index\.html/.test(t.url), 30000);
      const ijs = async (expr) => (await ide.cdp('Runtime.evaluate', { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true })).result?.result?.value;
      let ok = false;
      for (let end = Date.now() + 60000; Date.now() < end && !(ok = await ijs('window.__conquestReady === true')); await sleep(200));
      const mode = await ijs('ide.appMode');
      check(ok && mode === 'conquest', `clicking the fourth card opens Conquest and draws the map (${mode})`);
      ide.close();
      ch.close();
    } finally {
      try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {}
    }
  }

  // ---------- the other modes are as before ----------
  {
    const ctx = await launch({ fixture: 'core', port: 9832, name: 'conquest-app-code', mode: 'code' });
    const s = await ctx.js(`({ mode: ide.appMode, toolbar: getComputedStyle(document.getElementById('toolbar')).display, host: getComputedStyle(document.getElementById('conquestHost')).display,
      scripts: [...document.querySelectorAll('script[data-plugin]')].map((n) => n.dataset.plugin), conquest: typeof window.Conquest, actions: ide.actions.filter((a) => a.id.startsWith('Conquest.')).length,
      ipc: await ide.api.invoke('conquest:list').then(() => 'answered', (e) => 'no handler') })`);
    check(s.mode === 'code' && s.toolbar !== 'none' && s.host === 'none' && !s.scripts.includes('conquest') && s.conquest === 'undefined' && !s.actions && s.ipc === 'no handler',
      `--mode=code opens the IDE with no Conquest plugin, actions or channels (${S({ mode: s.mode, toolbar: s.toolbar, conquest: s.conquest, ipc: s.ipc, plugins: s.scripts.length })})`);
    done(ctx, 'code');
  }
  {
    const craftHome = path.join(tempDir('conquest-app-craft'), 'Craft Home');
    const ctx = await launch({ fixture: 'core', port: 9833, name: 'conquest-app-craft', mode: 'craft', env: { PYIDE_CRAFT_HOME: craftHome } });
    await ctx.until(`!!document.querySelector('#craftHost')?.children.length`, 'Craft drew its screen', 30000);
    const s = await ctx.js(`({ mode: ide.appMode, craft: getComputedStyle(document.getElementById('craftHost')).display, conquest: getComputedStyle(document.getElementById('conquestHost')).display,
      scripts: [...document.querySelectorAll('script[data-plugin]')].map((n) => n.dataset.plugin), title: document.title })`);
    check(s.mode === 'craft' && s.craft !== 'none' && s.conquest === 'none' && s.scripts.includes('minecraft') && !s.scripts.includes('conquest') && s.title.endsWith(`${PRODUCT} Craft`),
      `--mode=craft still opens Craft, without Conquest (${S({ mode: s.mode, title: s.title, conquest: s.scripts.includes('conquest') })})`);
    done(ctx, 'craft');
  }
} catch (err) {
  check(false, `the suite ran to the end (${err?.stack || err})`);
}

if (errors.length) console.log(`renderer exceptions or CSP violations:\n  ${errors.join('\n  ')}`);
check(!errors.length, 'no renderer exceptions or CSP violations');
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
