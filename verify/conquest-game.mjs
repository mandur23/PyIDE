// Nano Studio Conquest played through its screens (ui/, sim/host.js, sim/queries.js, main/features/conquest.js), with
// real mouse and key events: the start screen; a 1914 game as France that starts on 28 June 1914; Space and the speed
// keys; the province card against a `province` query (its trench fact and tooltip, and in a battle the defending line
// count and the marked line divisions; hovering its Supply, Infrastructure and Trenches facts and an army card's org);
// the battle window from a marker and from the card (columns, odds, factors, the division detail, Escape before the
// panel, following and ending the battle) and the marker and counter tooltips; pause-on-alert and an alert that focuses the map when war is
// declared; a province coloured by its new controller; a front and an offensive drawn on the French border (the
// screenshots verify/out/conquest-game-dark.png and conquest-game-light.png, left for the coordinator). Then a small
// generated map with two nations at war from day one: selecting an army highlights it, a front drawn with real clicks
// that the general fills within a bounded number of days, a launched offensive that attacks along its path, a
// division under direct control that moves where it is sent and stays there, a refused order's reason beside the
// cursor, a worker failure shown as a message with Reload Last Save, and quitting the window saves the game that
// Continue then restores (same date, state hash and plans). Commanding with the mouse (commandChecks): box selection
// and Shift, panning by right and middle drag, the arrow keys and the left-drag setting, the selection panel, the
// route preview and right-click move, the front and offensive previews with the attackOdds query, the minimap; the
// army bar's snapping, Tab and double click. Korean strings and particles. The static check of every tr() literal
// under ui/ and view/ (verify/i18n-static.mjs reads only a plugin's top folder). Ports 9838-9839.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, tempDir } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(APP_DIR, 'verify', 'out');
const FEATURE = path.join(APP_DIR, 'renderer', 'features', 'conquest');
const S = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const errors = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const done = (ctx, label) => {
  if (ctx.consoleErrors.length) errors.push(`${label}: ${ctx.consoleErrors.join(' | ')}`);
  if (ctx.cspViolations.length) errors.push(`${label} CSP: ${ctx.cspViolations.join(' | ')}`);
};

const G = 'Conquest.game';
const V = 'Conquest.app.view';
const home = path.join(tempDir('conquest-game'), 'Conquest Home');
const env = { PYIDE_CONQUEST_HOME: home, PYIDE_CONQUEST_TEST: '1' };

// Each game autosaves to its own file (ui/game.js); the newest one.
const newestAutosave = () => {
  const dir = path.join(home, 'Saves');
  const list = existsSync(dir) ? readdirSync(dir).filter((n) => /^Autosave( .+)?\.ncq$/.test(n)).map((n) => ({ n, t: statSync(path.join(dir, n)).mtimeMs })) : [];
  list.sort((a, b) => b.t - a.t);
  return list.length ? path.join(dir, list[0].n) : null;
};
const mouse = (ctx, type, x, y, extra = {}) => ctx.cdp('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1, ...extra });
async function clickAt(ctx, p, button = 'left') {
  await mouse(ctx, 'mouseMoved', p.x, p.y);
  await sleep(30);
  await mouse(ctx, 'mousePressed', p.x, p.y, { button, buttons: button === 'left' ? 1 : 2 });
  await mouse(ctx, 'mouseReleased', p.x, p.y, { button, buttons: 0 });
  await sleep(150);
}
// Page coordinates of a province's anchor (or a texture point), and whether the map is what is there.
const pagePoint = (ctx, mx, my) => ctx.js(`(() => { const r = document.querySelector('.cq-map').getBoundingClientRect(); const [x, y] = ${V}.camera.toScreen(${mx}, ${my});
  const at = document.elementFromPoint(r.left + x, r.top + y); return { x: r.left + x, y: r.top + y, lx: x, ly: y, onMap: !!at?.closest('.cq-map') }; })()`);
const anchor = async (ctx, id) => { const p = await ctx.js(`(({ x, y }) => ({ x, y }))(${V}.map.provinces[${id}])`); return pagePoint(ctx, p.x + 0.5, p.y + 0.5); };
// Centres the camera on these provinces at a zoom that shows them all in the middle of the map.
const frame = (ctx, ids, fill = 0.35) => ctx.js(`(() => { const v = ${V}; const P = v.map.provinces; const ps = ${S(ids)}.map((i) => P[i]);
  const xs = ps.map((p) => p.x); const ys = ps.map((p) => p.y); const w = Math.max(...xs) - Math.min(...xs) + 4; const h = Math.max(...ys) - Math.min(...ys) + 4;
  const c = v.camera; c.centerOn((Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2, Math.min(c.w * ${fill} / w, c.h * ${fill} / h, 16)); v.redraw(); return true; })()`);
// Speed 4 (three game days a second): speed 5 runs a small map so fast that a poll overshoots by weeks.
const runFor = async (ctx, hours, speed = 4, ms = 120000) => {
  const target = (await ctx.js(`${G}.hour`)) + hours;
  await ctx.js(`${G}.setSpeed(${speed}), true`);
  try { await ctx.until(`${G}.hour >= ${target} || ${G}.speed === 0`, `${hours} game hours`, ms); } finally { await ctx.js(`${G}.setSpeed(0), true`); }
  await sleep(200);
};
const runUntil = async (ctx, expr, label, maxHours, speed = 4) => {
  const end = (await ctx.js(`${G}.hour`)) + maxHours;
  await ctx.js(`${G}.setSpeed(${speed}), true`);
  let ok = false;
  try {
    await ctx.until(`(${expr}) || ${G}.hour >= ${end} || ${G}.status !== 'running'`, label, 240000);
    ok = await ctx.js(`!!(${expr})`);
  } finally { await ctx.js(`${G}.setSpeed(0), true`); }
  await sleep(250);
  return ok;
};
const shown = (sel) => `(() => { const n = document.querySelector(${S(sel)}); return !!n && !n.hidden && getComputedStyle(n).display !== 'none' && n.getClientRects().length > 0; })()`;
const text = (ctx, sel) => ctx.js(`document.querySelector(${S(sel)})?.textContent ?? null`);
// Contact provinces of the player's: held by the player, next to land an enemy holds, in a chain of neighbours.
// Near the player's capital first (the French border, not a colony's), a chain of up to six.
const CONTACT = (enemy) => `(() => { const g = ${G}; const P = g.map.provinces; const me = g.player; const foe = (c) => c >= 0 && (${enemy === undefined ? 'g.nations[c]?.war' : `c === ${enemy}`});
  const cap = P[g.scenario.nations[me].capital]; const far = (p) => (P[p].x - cap.x) ** 2 + (P[p].y - cap.y) ** 2;
  const contact = []; for (let p = 1; p < P.length; p++) if (!P[p].sea && g.prov.ctrl[p] === me && P[p].adj.some((q) => !P[q].sea && foe(g.prov.ctrl[q]))) contact.push(p);
  contact.sort((a, b) => far(a) - far(b));
  const set = new Set(contact); let best = [];
  for (const s of contact) { const chain = [s]; let cur = s; for (let i = 0; i < 5; i++) { const n = P[cur].adj.find((q) => set.has(q) && !chain.includes(q)); if (!n) break; chain.push(n); cur = n; } if (chain.length > best.length) best = chain; if (best.length >= 3) break; }
  const enemyNext = best.length ? P[best[0]].adj.find((q) => !P[q].sea && foe(g.prov.ctrl[q])) : 0;
  return { chain: best, enemyNext }; })()`;

// A key as the numpad sends it: the same `key` as the main row, its own `code`.
const numpad = async (ctx, key, code, vk) => {
  for (const type of ['rawKeyDown', 'keyUp']) await ctx.cdp('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, modifiers: 0 });
  await sleep(80);
};
const rectsOverlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const setState = (ctx, set) => ctx.js(`${G}.debug.setState(${S(set)}).then(() => true)`);
const snapTo = async (ctx, file) => {
  if (!process.env.CONQUEST_SHOTS) return;
  const r = await ctx.cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(process.env.CONQUEST_SHOTS, file), Buffer.from(r.result.data, 'base64'));
  console.log(`screenshot: ${path.join(process.env.CONQUEST_SHOTS, file)}`);
};
const WINDOW = `(() => { const box = document.querySelector('.cq-battle'); if (!box || box.hidden) return null; const ids = (side) => [...box.querySelectorAll('.cq-battle-col[data-side="' + side + '"] .cq-bdiv')].map((r) => Number(r.dataset.div));
  return { prov: Number(box.dataset.province), ended: box.dataset.ended, odds: Number(box.querySelector('.cq-balance')?.dataset.odds), att: ids('att'), def: ids('def'), hours: Conquest.ui.battle.data?.hours,
    factors: [...box.querySelectorAll('.cq-factor')].map((f) => f.dataset.k), sub: box.querySelector('.cq-battle-sub')?.textContent, end: box.querySelector('.cq-battle-end')?.textContent ?? null,
    labelled: box.getAttribute('role') === 'dialog' && document.getElementById(box.getAttribute('aria-labelledby'))?.textContent }; })()`;

// The battle window (ui/battle.js) on a battle of the 1914 game, opened by the real click on its marker that came
// before: both columns against the `battle` query and the mirror, the odds equal to the marker's, the factors, the
// division detail, Escape before the panel, opening from the card's Battle fact, following the battle for some hours,
// its end, and the hover tooltips of a marker and a counter.
async function battleWindow(ctx, mp, markerPt) {
  const { js, until } = ctx;
  await until(`!!document.querySelector('.cq-battle:not([hidden]) .cq-balance')`, 'the battle window', 8000).catch(() => {});
  const w0 = await js(WINDOW);
  const q = await js(`${G}.query('battle', { prov: ${mp} })`);
  const mirror = await js(`(() => { const g = ${G}; const b = g.battles.find((x) => x.prov === ${mp}); const m = ${V}.markers.find((x) => x.prov === ${mp}); return { odds: b?.odds, marker: m && m.odds, mine: m && m.mine, side: b?.side, ctrl: g.prov.ctrl[${mp}],
    known: [...g.divs.keys()] }; })()`);
  const same = (a, b) => S([...a].sort((x, y) => x - y)) === S([...b].sort((x, y) => x - y));
  check(w0 && w0.prov === mp && w0.labelled && same(w0.att, q.att.map((d) => d.id)) && same(w0.def, q.def.map((d) => d.id)) && w0.att.length > 0 && w0.def.length > 0
    && w0.att.concat(w0.def).every((id) => mirror.known.includes(id)),
    `the marker click opens the battle window, a labelled dialog with the attackers and defenders in two columns, the divisions of the mirror (${S({ w: w0 && { att: w0.att.length, def: w0.def.length }, q: { att: q.att.length, def: q.def.length } })})`);
  check(w0 && w0.odds === mirror.odds && (mirror.marker === mirror.odds || mirror.marker === 1000 - mirror.odds) && q.hour && q.hour.odds === mirror.odds && w0.factors.length > 0,
    `its odds are the battle's and the marker's, and the factors that make them are listed (${S({ odds: w0?.odds, mirror, factors: w0?.factors })})`);
  await snapTo(ctx, 'stage3-battle-dark.png');
  await js(`(ide.settings.set('appearance.theme', 'light'), true)`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'the light theme', 5000);
  await sleep(400);
  await snapTo(ctx, 'stage3-battle-light.png');
  await js(`(ide.settings.set('appearance.theme', 'dark'), true)`);
  await until(`document.documentElement.dataset.theme !== 'light'`, 'the dark theme', 5000);

  // A division row of the window opens the division detail with its template's composition.
  const did = w0?.att[0];
  if (did) {
    await ctx.click(`.cq-battle .cq-bdiv[data-div="${did}"]`);
    await until(`!!document.querySelector('.cq-battle .cq-div-detail[data-div="${did}"]')`, 'the division detail', 5000).catch(() => {});
    const dq = await js(`${G}.query('division', { id: ${did} })`);
    const dd = await js(`(() => { const n = document.querySelector('.cq-battle .cq-div-detail'); return n && { line: n.querySelector('.cq-dd-comp')?.dataset.line, support: n.querySelector('.cq-dd-comp')?.dataset.support, stats: n.querySelectorAll('.cq-dd-stat').length,
      bars: [...n.querySelectorAll('.cq-meter')].map((m) => Number(m.dataset.v)), who: n.querySelector('.cq-dd-who')?.textContent }; })()`);
    check(dd && dq.template && dd.line === dq.template.line.join(',') && dd.support === dq.template.support.join(',') && dd.stats >= 8 && S(dd.bars) === S([dq.org, dq.str, dq.sup]) && !!dd.who,
      `a division row opens the division detail: its template's composition, stats, organisation, strength and supply, and who directs it (${S({ dd, tpl: dq.template })})`);
    await snapTo(ctx, 'stage3-division-dark.png');
  } else check(false, 'the battle window lists an attacker to open');

  // Escape: the division detail, then the window, then the panel.
  await js(`(Conquest.ui.shell.openPanel('production'), document.activeElement?.blur?.(), true)`);
  await sleep(200);
  const state = () => js(`({ detail: !!Conquest.ui.divDetail.id, window: Conquest.ui.battle.prov, panel: Conquest.ui.shell.panelOpen ?? null })`);
  await ctx.press('Escape');
  const e1 = await state();
  await ctx.press('Escape');
  const e2 = await state();
  await ctx.press('Escape');
  const e3 = await state();
  check(e1.window === mp && !e1.detail && e2.window === 0 && e2.panel === 'production' && !e3.panel, `Escape closes the division detail, then the battle window, then the panel (${S({ e1, e2, e3 })})`);

  // From the card's Battle fact.
  await js(`(${G}.setSelection({ province: ${mp} }), ${V}.setSelected(${mp}), true)`);
  await until(`document.querySelector('.cq-card')?.dataset.province === '${mp}' && !!document.querySelector('.cq-fact-battle')`, 'the battle fact', 8000).catch(() => {});
  await ctx.click('.cq-fact-battle .cq-fact-value');
  await until(`Conquest.ui.battle.prov === ${mp}`, 'the window from the card', 5000).catch(() => {});
  const fromCard = await js(WINDOW);
  check(fromCard && fromCard.prov === mp, `the card's Battle fact opens the same battle's window (${S(fromCard && { prov: fromCard.prov })})`);

  // It follows the battle, then says how it ended and stays.
  const h0 = fromCard?.hours ?? 0;
  await runFor(ctx, 4, 1);
  await sleep(500);
  const w1 = await js(WINDOW);
  const b1 = await js(`${G}.battles.find((x) => x.prov === ${mp}) || null`);
  check(w1 && (w1.ended || (b1 && w1.hours === b1.hours && w1.hours > h0 && w1.odds === b1.odds)), `the open window follows the battle hour by hour (${S({ h0, w1: w1 && { hours: w1.hours, odds: w1.odds, ended: w1.ended }, b1: b1 && { hours: b1.hours, odds: b1.odds } })})`);
  if (b1) {
    // Every defender at org 0 ends it on the next hour (state.divs is in id order, so a division's index is its rank).
    const set = await js(`(() => { const g = ${G}; const ids = [...g.divs.keys()].sort((a, b) => a - b); const out = [];
      for (const d of g.divs.values()) if (d.prov === ${mp} && g.nations[d.nation] && (d.nation === g.prov.ctrl[${mp}] || ${S(q.def.map((d) => d.id))}.includes(d.id))) out.push({ path: ['divs', ids.indexOf(d.id), 'org'], value: 0 });
      return out; })()`);
    await setState(ctx, set);
    await runUntil(ctx, `!!Conquest.ui.battle.ended`, 'the end of the battle', 24 * 3, 1);
  }
  const w2 = await js(WINDOW);
  check(w2 && w2.prov === mp && !!w2.end && /over/.test(w2.end), `when the battle ends the window says how and stays open (${S(w2 && { ended: w2.ended, end: w2.end })})`);
  await ctx.press('Escape');
  check(!(await js(`Conquest.ui.battle.prov`)), 'Escape closes the ended battle window');

  // Hover tooltips: a battle marker, then a counter; leaving hides them.
  const other = await js(`(() => { const g = ${G}; return g.battles[0]?.prov || 0; })()`);
  if (other) {
    await js(`(${G}.setSelection({ province: 0 }), ${V}.setSelected(0), ${V}.camera.centerOn(${V}.map.provinces[${other}].x, ${V}.map.provinces[${other}].y, 3), ${V}.redraw(), true)`);
    await sleep(250);
    const mpt = await js(`(() => { const m = ${V}.markers.find((x) => x.prov === ${other}); const [x, y] = ${V}.markerPoint(m); const r = document.querySelector('.cq-map').getBoundingClientRect(); return { x: r.left + x, y: r.top + y }; })()`);
    await mouse(ctx, 'mouseMoved', mpt.x, mpt.y);
    await until(`document.querySelector('.cq-tip:not([hidden])')?.dataset.kind === 'battle'`, 'the marker tooltip', 4000).catch(() => {});
    const mt = await js(`(() => { const t = document.querySelector('.cq-tip'); return { kind: t.dataset.kind, odds: Number(t.dataset.odds), text: t.textContent, want: ${G}.battles.find((b) => b.prov === ${other})?.odds }; })()`);
    check(mt.kind === 'battle' && mt.odds === mt.want && /Click for details/.test(mt.text), `hovering a battle marker gives its one-line summary and "click for details" (${S(mt)})`);
  } else check(false, 'a battle is left to hover');
  const cpt = await js(`(() => { const v = ${V}; const c = v.camera; const P = v.map.provinces; const b = Conquest.ui.shell.bind; const r0 = document.querySelector('.cq-map').getBoundingClientRect();
    for (const k of v.counters()) { const [x, y] = c.toScreen(P[k.prov].x + 0.5, P[k.prov].y + 0.5); const px = Math.round(x + k.dx); const py = Math.round(y + k.dy);
      if (px < 30 || py < 30 || px > c.w - 30 || py > c.h - 30 || v.markerAt(px, py) || !document.elementFromPoint(r0.left + px, r0.top + py)?.closest('.cq-map')) continue;
      const hit = b.counterAt(px, py); if (!hit) continue;
      const ids = hit.all.flatMap((g) => g.divs); const ds = ids.map((id) => ${G}.divs.get(id));
      return { x: r0.left + px, y: r0.top + py, count: ids.length, str: Math.round(ds.reduce((s, d) => s + d.str, 0) / ids.length), org: Math.round(ds.reduce((s, d) => s + d.org, 0) / ids.length), merged: hit.all.length }; }
    return null; })()`);
  if (cpt) {
    await mouse(ctx, 'mouseMoved', cpt.x, cpt.y);
    await until(`document.querySelector('.cq-tip:not([hidden])')?.dataset.kind === 'counter'`, 'the counter tooltip', 4000).catch(() => {});
    const ct = await js(`(() => { const t = document.querySelector('.cq-tip'); return { kind: t.dataset.kind, count: Number(t.dataset.count), str: Number(t.dataset.str), org: Number(t.dataset.org), merged: Number(t.dataset.merged), text: t.textContent }; })()`);
    await snapTo(ctx, 'stage3-tooltip-dark.png');
    await mouse(ctx, 'mouseMoved', 5, 300);
    await sleep(200);
    const gone = await js(`(() => { const t = document.querySelector('.cq-tip'); return t.hidden || t.dataset.kind !== 'counter'; })()`);
    check(ct.kind === 'counter' && ct.count === cpt.count && ct.str === cpt.str && ct.org === cpt.org && ct.merged === cpt.merged && /divisions/.test(ct.text) && (cpt.merged === 1 || /Merged counter/.test(ct.text)) && gone,
      `hovering a counter says whose stack it is with its divisions' count, mean strength and organisation, and leaving hides it (${S({ ct, want: cpt, gone })})`);
  } else check(false, 'a counter is on screen to hover');
}

// The screen frame (ui/shell.js, ui/command.js) on a 1914 game at war, paused: time keys and the paused state, keys
// while typing or with a dialog open, panel keys with one panel at a time beside the card, map mode and legend keys,
// a resource tooltip against the economy query, a burst of alerts, loss alerts read from who held the province
// before, France's name at the Europe view with Paris cut off and then lost, and the army bar with seven armies.
async function frameChecks(ctx, armyId) {
  const { js, until } = ctx;
  await js(`(${G}.setSpeed(0), ${G}.setSelection({ province: 0, divisions: [], army: null }), ${V}.setSelected(0), Conquest.ui.shell.openPanel(null), document.activeElement?.blur?.(), true)`);
  const flag = () => js(`({ flag: ${shown('.cq-paused-flag')}, root: document.querySelector('.cq-app').classList.contains('cq-paused'), pressed: document.querySelector('.cq-speed-pause').getAttribute('aria-pressed') })`);
  const paused = await flag();
  await ctx.press('2');
  const running = await flag();
  const s2 = await js(`${G}.speed`);
  await numpad(ctx, '+', 'NumpadAdd', 107);
  const s3 = await js(`${G}.speed`);
  await numpad(ctx, '-', 'NumpadSubtract', 109);
  const s2b = await js(`${G}.speed`);
  await ctx.press('=');
  const s3b = await js(`${G}.speed`);
  await numpad(ctx, '4', 'Numpad4', 100);
  const s4 = await js(`${G}.speed`);
  await ctx.press('Space');
  const s0 = await js(`${G}.speed`);
  check(paused.flag && paused.root && paused.pressed === 'true' && !running.flag && !running.root && s2 === 2 && s3 === 3 && s2b === 2 && s3b === 3 && s4 === 4 && s0 === 0 && (await flag()).flag,
    `the paused flag shows only while paused; 2, numpad +, numpad -, = and numpad 4 set the speed and Space pauses (${S({ paused, running, speeds: [s2, s3, s2b, s3b, s4, s0] })})`);

  // Panel keys: one panel at a time, docked left of the map; Escape closes the panel, then clears the selection.
  const capital = await js(`${G}.scenario.nations[${G}.player].capital`);
  await js(`(${G}.setSelection({ province: ${capital} }), ${V}.setSelected(${capital}), true)`);
  await until(`document.querySelector('.cq-card')?.dataset.province === '${capital}'`, 'the card of Paris', 8000);
  await ctx.press('Q');
  const q = await js(`({ open: Conquest.ui.shell.panelOpen, active: [...document.querySelectorAll('.cq-dock-tab.active')].map((b) => b.dataset.panel) })`);
  await ctx.press('W');
  await sleep(200);
  const w = await js(`(() => { const d = document.querySelector('.cq-dock').getBoundingClientRect(); const c = document.querySelector('.cq-card').getBoundingClientRect(); const m = document.querySelector('.cq-map').getBoundingClientRect();
    return { open: Conquest.ui.shell.panelOpen, active: [...document.querySelectorAll('.cq-dock-tab.active')].map((b) => b.dataset.panel), shownPanels: [...document.querySelectorAll('.cq-panel')].filter((p) => !p.hidden).length,
      dock: [d.left, d.right], card: [c.left, c.right, c.width], map: [m.left, m.right], cardShown: ${shown('.cq-card')}, title: document.querySelector('.cq-dock-tab[data-panel="designer"]').title }; })()`);
  check(q.open === 'production' && S(q.active) === S(['production']) && w.open === 'designer' && S(w.active) === S(['designer']) && w.shownPanels === 1 && w.cardShown && w.card[2] > 100
    && w.dock[1] <= w.map[0] + 1 && w.card[0] >= w.dock[1] && /\(W\)$/.test(w.title),
    `Q and W open Production and then the Division Designer alone, docked left of the map, with the province card beside it and the key in the tooltip (${S({ q, w })})`);
  await ctx.press('Escape');
  const e1 = await js(`({ open: Conquest.ui.shell.panelOpen, sel: ${G}.selection.province })`);
  await ctx.press('Escape');
  const e2 = await js(`({ open: Conquest.ui.shell.panelOpen, sel: ${G}.selection.province })`);
  check(e1.open === null && e1.sel === capital && e2.sel === 0, `Escape closes the open panel first and clears the selection after (${S({ e1, e2 })})`);

  // Map mode and legend keys.
  await ctx.press('F2');
  const m2 = await js(`${V}.mode`);
  await ctx.press('F1');
  const m1 = await js(`${V}.mode`);
  const legendBefore = await js(`ide.settings.get('conquest.legend', false) === true`);
  await ctx.press('L');
  const legend = await js(`({ shown: ${shown('.cq-legend')}, pressed: document.querySelector('.cq-legend-toggle').getAttribute('aria-pressed'), saved: ide.settings.get('conquest.legend') })`);
  await ctx.press('L');
  const legendOff = await js(`({ shown: ${shown('.cq-legend')}, saved: ide.settings.get('conquest.legend') })`);
  check(m2 === 'terrain' && m1 === 'political' && !legendBefore && legend.shown && legend.pressed === 'true' && legend.saved === true && !legendOff.shown && legendOff.saved === false,
    `F2 and F1 switch the map mode, L opens and closes the legend and stores it (${S({ m2, m1, legend, legendOff })})`);

  // No game key while typing in a field or while a dialog is open.
  await ctx.press('E');
  await until(`!!document.querySelector('.cq-dip-search')`, 'the diplomacy search field', 8000);
  await js(`(document.querySelector('.cq-dip-search').focus(), true)`);
  for (const k of ['Space', '3', 'Q', 'F2', 'L']) await ctx.press(k);
  const typed = await js(`({ speed: ${G}.speed, open: Conquest.ui.shell.panelOpen, mode: ${V}.mode, legend: ide.settings.get('conquest.legend'), value: document.querySelector('.cq-dip-search').value, focus: document.activeElement?.className })`);
  await js(`(document.activeElement.blur(), document.querySelector('.cq-dip-search').value = '', true)`);
  await ctx.click('.cq-save');
  await until(`!!document.querySelector('.dialog-buttons button.primary')`, 'the save dialog', 5000);
  for (const k of ['3', 'Q']) await ctx.press(k);
  const dialog = await js(`({ speed: ${G}.speed, open: Conquest.ui.shell.panelOpen })`);
  await ctx.click('.dialog-buttons button:not(.primary)');
  await until(`!document.querySelector('.dialog-backdrop, .modal-backdrop')`, 'the dialog closed', 5000).catch(() => {});
  check(typed.speed === 0 && typed.open === 'diplomacy' && typed.mode === 'political' && typed.legend === false && dialog.speed === 0 && dialog.open === 'diplomacy',
    `typing in a field or a dialog being open sends no game key (${S({ typed, dialog })})`);
  await js(`(Conquest.ui.shell.openPanel(null), true)`);

  // A resource tooltip says what the number is and breaks it down as the economy query does.
  const chip = await js(`(() => { const r = document.querySelector('.cq-stat[data-stat="mil"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await mouse(ctx, 'mouseMoved', chip.x, chip.y);
  await until(`${shown('.cq-stat-tip')} && !!document.querySelector('.cq-stat-tip .cq-tip-row[data-k="free"]')`, 'the factory tooltip', 8000);
  const eco = await js(`${G}.query('economy', {})`);
  const tipRows = (k) => js(`Object.fromEntries([...document.querySelectorAll('.cq-stat-tip .cq-tip-row')].map((r) => [r.dataset.k, Number(r.dataset.v)]))`);
  const milTip = await tipRows();
  const coalAt = await js(`(() => { const r = document.querySelector('.cq-stat[data-stat="coal"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await mouse(ctx, 'mouseMoved', coalAt.x, coalAt.y);
  await until(`document.querySelector('.cq-stat-tip')?.dataset.stat === 'coal' && !!document.querySelector('.cq-stat-tip .cq-tip-row[data-k="demand"]')`, 'the coal tooltip', 8000);
  const coalTip = await tipRows();
  const head = await text(ctx, '.cq-stat-tip .cq-tip-head');
  const fatAt = await js(`(() => { const r = document.querySelector('.cq-stat[data-stat="fatigue"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await mouse(ctx, 'mouseMoved', fatAt.x, fatAt.y);
  await until(`document.querySelector('.cq-stat-tip')?.dataset.stat === 'fatigue' && !!document.querySelector('.cq-stat-tip .cq-tip-row[data-k="collapse"]')`, 'the fatigue tooltip', 8000);
  const fatTip = await tipRows();
  const fatNote = await text(ctx, '.cq-stat-tip .cq-tip-note');
  const me = await js(`({ fatigue: ${G}.nations[${G}.player].fatigue, suff: ${G}.nations[${G}.player].suff.coal, mil: ${G}.factories.mil })`);
  await mouse(ctx, 'mouseMoved', 5, 300);
  const gone = !(await js(shown('.cq-stat-tip')));
  const R = eco.resources.coal;
  check(milTip.mil === me.mil && milTip.used === eco.used && milTip.free === eco.free && eco.used + eco.free === eco.mil && head === 'Coal' && coalTip.suff === me.suff && coalTip.own === R.own && coalTip.imported === R.imported
    && coalTip.demand === R.demand && fatTip.fatigue === me.fatigue && fatTip.capitulate === eco.fatigue.capitulate && fatTip.collapse === eco.fatigue.collapse && fatNote.length > 30 && gone,
    `the factory, coal and fatigue tooltips break their numbers down as the mirror and the economy query do, and leave with the pointer (${S({ milTip, eco: { used: eco.used, free: eco.free, coal: R, fatigue: eco.fatigue }, coalTip, fatTip, fatNote })})`);

  // A burst of alerts: at most three toasts over a small part of the map, every alert counted under its badge.
  const before = await js(`Conquest.ui.shell.alertCounts()`);
  await js(`(() => { const s = Conquest.ui.shell; for (let i = 0; i < 3; i++) { s.alert('battle-lost', 'Battle ' + i, 0, 'b' + i); s.alert('event', 'Event ' + i); s.alert('taken', 'Taken ' + i, 0, 't' + i); s.alert('low-supply', 'Supply ' + i); } return true; })()`);
  await sleep(200);
  const burst = await js(`(() => { const st = document.querySelector('.cq-stage').getBoundingClientRect(); let area = 0;
    for (const n of document.querySelectorAll('.cq-alerts > *')) { if (n.hidden || !n.getClientRects().length) continue; const r = n.getBoundingClientRect(); area += r.width * r.height; }
    return { toasts: [...document.querySelectorAll('.cq-alert')].map((a) => a.dataset.kind), share: area / (st.width * st.height), counts: Conquest.ui.shell.alertCounts(),
      badges: Object.fromEntries([...document.querySelectorAll('.cq-alert-badge')].map((b) => [b.dataset.kind, Number(b.querySelector('.cq-alert-count').textContent)])), speed: ${G}.speed }; })()`);
  const grew = ['battle-lost', 'event', 'taken', 'low-supply'].every((k) => burst.counts[k] === (before[k] || 0) + 3 && burst.badges[k] === burst.counts[k]);
  check(burst.toasts.length <= 3 && burst.share < 0.1 && grew && S(burst.badges) === S(burst.counts),
    `twelve alerts at once leave at most three toasts on ${Math.round(burst.share * 1000) / 10}% of the map, and each kind's badge counts all of them (${S({ before, ...burst })})`);
  await sleep((await js(`Conquest.ui.shell.TOAST_MS`)) + 600);
  const left = await js(`[...document.querySelectorAll('.cq-alert')].map((a) => a.dataset.kind)`);
  await ctx.click('.cq-alert-badge[data-kind="event"]');
  const list = await js(`({ rows: document.querySelectorAll('.cq-alert-pop .cq-alert-entry').length, n: Conquest.ui.shell.alertCounts().event })`);
  await ctx.press('Escape');
  const closed = !(await js(shown('.cq-alert-pop')));
  check(left.every((k) => k === 'war' || k === 'offer') && list.rows >= 3 && list.rows <= list.n && closed,
    `the toasts that are not war or offers leave by themselves, a badge opens its kind's list and Escape closes it (${S({ left, list, closed })})`);

  // Province lost: decided from who held it before. An enemy taking a French-held province is a loss; an ally taking it
  // from the enemy is not.
  const who = await js(`(() => { const g = ${G}; const P = g.map.provinces; const me = g.player; const cap = g.scenario.nations[me].capital;
    let p = 0; for (let i = 1; i < P.length; i++) if (!P[i].sea && i !== cap && g.prov.ctrl[i] === me && g.prov.owner[i] === me && P[i].area > 2000) { p = i; break; }
    const enemy = g.nations.findIndex((n) => n.war && n.alive); const ally = g.nations.findIndex((n) => n.ally && n.alive); return { p, enemy, ally, me, hour: g.hour }; })()`);
  const lostBefore = (await js(`Conquest.ui.shell.alertCounts().lost`)) || 0;
  await setState(ctx, [{ path: ['prov', 'ctrl', who.p], value: who.enemy }, { path: ['log'], value: [{ kind: 'taken', prov: who.p, by: who.enemy, hour: who.hour }] }]);
  await until(`(Conquest.ui.shell.alertCounts().lost || 0) > ${lostBefore}`, 'the loss alert', 8000).catch(() => {});
  const lostEnemy = (await js(`Conquest.ui.shell.alertCounts().lost`)) || 0;
  await setState(ctx, [{ path: ['prov', 'ctrl', who.p], value: who.ally }, { path: ['log'], value: [{ kind: 'taken', prov: who.p, by: who.ally, hour: who.hour }] }]);
  await sleep(1200);
  const afterAlly = await js(`({ lost: Conquest.ui.shell.alertCounts().lost || 0, ctrl: ${G}.prov.ctrl[${who.p}], allySide: Conquest.ui.sideOf(${G}, ${who.ally}) })`);
  await setState(ctx, [{ path: ['prov', 'ctrl', who.p], value: who.me }, { path: ['log'], value: [] }]);
  check(who.p > 0 && who.enemy >= 0 && who.ally >= 0 && lostEnemy === lostBefore + 1 && afterAlly.lost === lostEnemy && afterAlly.ctrl === who.ally && afterAlly.allySide === 'ally',
    `an enemy taking a French-held province raises a loss alert; an ally taking it back raises none (${S({ who, lostBefore, lostEnemy, afterAlly })})`);

  // France keeps a visible name at the Europe view when Paris is cut off in a pocket, and when Paris is lost.
  const europe = `(() => { const v = ${V}; const P = v.map.provinces; const c = P[${capital}]; v.camera.centerOn(c.x + 260, c.y + 40, Math.max(v.camera.w / 1500, 0.55)); v.redraw(); return true; })()`;
  const fraName = () => js(`(() => { const v = ${V}; const c = v.camera; const g = ${G}; const l = v.labels.find((x) => x.nation === g.player && x.main); if (!l) return null; const [sx, sy] = c.toScreen(l.x, l.y);
    const cap = v.map.provinces[${capital}]; return { px: Math.round(Math.min(44, l.size * c.scale) * 10) / 10, sx: Math.round(sx), sy: Math.round(sy), w: c.w, h: c.h, alpha: v.labelAlpha, ctrl: g.prov.ctrl[v.provinceAt(sx, sy)],
      fromCapital: Math.round(Math.hypot(l.x - cap.x, l.y - cap.y)) }; })()`);
  const ring = await js(`${S(capital)} && ${V}.map.provinces[${capital}].adj.filter((q) => !${V}.map.provinces[q].sea && ${G}.prov.ctrl[q] === ${G}.player)`);
  await setState(ctx, ring.map((q) => ({ path: ['prov', 'ctrl', q], value: who.enemy })));
  await sleep(1200);
  await js(europe);
  await sleep(300);
  const pocket = await fraName();
  await setState(ctx, [{ path: ['prov', 'ctrl', capital], value: who.enemy }]);
  await sleep(1200);
  await js(europe);
  await sleep(300);
  const lost = await fraName();
  await setState(ctx, [...ring, capital].map((q) => ({ path: ['prov', 'ctrl', q], value: who.me })));
  const visible = (n) => n && n.px >= 7 && n.alpha > 0 && n.sx > 0 && n.sy > 0 && n.sx < n.w && n.sy < n.h && n.ctrl === who.me && n.fromCapital < 400;
  check(ring.length > 0 && visible(pocket) && visible(lost), `with Paris cut off and then lost, France's name stays on its homeland, on screen and at least 7 px tall at the Europe view (${S({ ring: ring.length, pocket, lost })})`);

  // The army bar with seven armies: one row, no card's text cut, the selected army in view.
  let armies = await js(`${G}.me.armies.length`);
  for (let i = armies; i < 7; i++) await js(`${G}.order({ type: 'army', name: 'Armée de réserve ${i}', general: null })`);
  await sleep(400);
  armies = await js(`${G}.me.armies.length`);
  const last = await js(`${G}.me.armies[${G}.me.armies.length - 1].id`);
  await js(`(${G}.setSelection({ army: ${last}, divisions: [] }), true)`);
  await sleep(500);
  const strip = await js(`(() => { const l = document.querySelector('.cq-army-list'); const lr = l.getBoundingClientRect(); const cards = [...l.querySelectorAll('.cq-army')];
    const clipped = []; for (const c of cards) for (const n of [c, ...c.children]) if (n.scrollWidth > n.clientWidth + 1) clipped.push([c.dataset.army, n.className, n.scrollWidth, n.clientWidth]);
    const a = l.querySelector('.cq-army.active').getBoundingClientRect(); const over = l.scrollWidth > l.clientWidth + 1;
    return { cards: cards.length, rows: new Set(cards.map((c) => c.offsetTop)).size, clipped, over, bar: l.offsetHeight - l.clientHeight, arrows: ${shown('.cq-army-next')} && ${shown('.cq-army-prev')},
      inView: a.left >= lr.left - 1 && a.right <= lr.right + 1, scroll: l.scrollLeft }; })()`);
  let wheel = null;
  if (strip.over) {
    await js(`(document.querySelector('.cq-army-list').scrollLeft = 0, true)`);
    const at = await js(`(() => { const r = document.querySelector('.cq-army-list').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await ctx.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: 240 });
    await sleep(300);
    wheel = await js(`document.querySelector('.cq-army-list').scrollLeft`);
  }
  check(armies >= 7 && strip.cards === armies && strip.rows === 1 && !strip.clipped.length && strip.bar === 0 && strip.inView && (!strip.over || (strip.arrows && wheel > 0)),
    `with ${armies} armies the bar keeps one row, cuts no card's text, scrolls with the wheel and its arrows and keeps the selected army in view (${S({ ...strip, wheel })})`);

  // The row snaps to a card's edge: after the arrow and after the wheel no card is cut at the left end.
  const narrow = !strip.over;
  if (narrow) await js(`(document.querySelector('.cq-army-list').style.maxWidth = '520px', true)`);
  await js(`(document.querySelector('.cq-army-list').scrollLeft = 0, true)`);
  await sleep(200);
  const firstCut = `(() => { const l = document.querySelector('.cq-army-list'); const lr = l.getBoundingClientRect(); const seen = [...l.querySelectorAll('.cq-army')].map((c) => c.getBoundingClientRect()).filter((r) => r.right > lr.left + 1);
    return { scroll: Math.round(l.scrollLeft), cut: seen.length ? Math.round(lr.left - seen[0].left) : null }; })()`;
  await ctx.click('.cq-army-next');
  await sleep(900);
  const afterArrow = await js(firstCut);
  const at2 = await js(`(() => { const r = document.querySelector('.cq-army-list').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await ctx.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at2.x, y: at2.y, deltaX: 0, deltaY: 70 });
  await sleep(900);
  const afterWheel = await js(firstCut);
  check(afterArrow.scroll > 0 && afterArrow.cut !== null && afterArrow.cut <= 0 && afterWheel.cut !== null && afterWheel.cut <= 0, `the army row snaps to a card's edge, so no card is cut at its left end after the arrow or the wheel (${S({ narrow, afterArrow, afterWheel })})`);
  if (narrow) await js(`(document.querySelector('.cq-army-list').style.maxWidth = '', true)`);

  // Tab and Shift+Tab step through the armies; a double click on a card centres the map on the army.
  await js(`(${G}.setSelection({ army: null, divisions: [], province: 0 }), document.activeElement?.blur?.(), true)`);
  const ids = await js(`${G}.me.armies.map((a) => a.id)`);
  await ctx.press('Tab');
  const t1 = await js(`${G}.selection.army`);
  await ctx.press('Tab');
  const t2 = await js(`${G}.selection.army`);
  await ctx.press('Shift+Tab');
  const t3 = await js(`${G}.selection.army`);
  check(t1 === ids[0] && t2 === ids[1] && t3 === ids[0], `Tab and Shift+Tab step through the armies (${S({ ids: ids.slice(0, 3), t1, t2, t3 })})`);
  const withDivs = await js(`${G}.me.armies.find((a) => a.divs.length >= 2 && a.id !== ${t3})?.id ?? null`);
  if (withDivs !== null) {
    await js(`(${V}.camera.centerOn(5, 5, 1), ${V}.redraw(), document.querySelector('.cq-army[data-army="${withDivs}"]').scrollIntoView({ inline: 'nearest' }), true)`);
    await sleep(300);
    const cr = await js(`(() => { const r = document.querySelector('.cq-army[data-army="${withDivs}"]').getBoundingClientRect(); return { x: r.left + 20, y: r.top + 10 }; })()`);
    await mouse(ctx, 'mouseMoved', cr.x, cr.y);
    await mouse(ctx, 'mousePressed', cr.x, cr.y, { buttons: 1, clickCount: 1 });
    await mouse(ctx, 'mouseReleased', cr.x, cr.y, { buttons: 0, clickCount: 1 });
    await mouse(ctx, 'mousePressed', cr.x, cr.y, { buttons: 1, clickCount: 2 });
    await mouse(ctx, 'mouseReleased', cr.x, cr.y, { buttons: 0, clickCount: 2 });
    await sleep(300);
    const centred = await js(`(() => { const g = ${G}; const v = ${V}; const c = v.camera; const [mx, my] = c.toMap(c.w / 2, c.h / 2); const P = v.map.provinces;
      const provs = g.me.armies.find((a) => a.id === ${withDivs}).divs.map((id) => g.divs.get(id)?.prov).filter(Boolean);
      return { sel: g.selection.army, near: Math.min(...provs.map((p) => Math.hypot(P[p].x - mx, P[p].y - my))), clamped: c.x <= 0.01 || c.y <= 0.01 }; })()`);
    check(centred.sel === withDivs && (centred.near < 2 || centred.clamped), `a double click on an army card selects the army and centres the map on its divisions (${S(centred)})`);
  } else check(false, 'an army with divisions to centre on');
  await js(`(${G}.setSelection({ army: ${armyId}, divisions: [], province: 0 }), true)`);
}

// Commanding with the mouse on the generated map (ui/selectbox.js, ui/selpanel.js, ui/command.js, ui/minimap.js): a
// box drag selects exactly the player's stacks inside it and Shift adds; a left drag does not move the map, a right
// or middle drag and the arrow keys do, and the setting flips the left drag; the selection panel lists the selection
// and its Halt, Direct Control and Give Back change the mirrored divisions, with a refused action disabled and its
// reason; a route preview with the `route` query's arrival, a right click that sends every selected division, a refused
// move with its reason; drawing a front previews the border edges between the camps and sets the front; an offensive
// shows the `attackOdds` query; the minimap's rectangle follows the camera and a click on it moves the view.
async function commandChecks(ctx, army) {
  const { js, until } = ctx;
  const P0 = await js(`(() => { const r = document.querySelector('.cq-map').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
  await js(`(${G}.setSpeed(0), ${G}.setSelection({ province: 0, divisions: [], army: null }), ${V}.setSelected(0), Conquest.ui.shell.openPanel(null), ide.settings.set('conquest.leftDrag', 'select'), true)`);
  const ownDivs = await js(`[...${G}.divs.values()].filter((d) => d.nation === ${G}.player && !${G}.map.provinces[d.prov].sea).map((d) => d.prov)`);
  await frame(ctx, [...new Set(ownDivs)], 0.5);
  await sleep(300);
  // Counters of the player's on screen with no other counter near them, in page pixels.
  const lonely = await js(`(() => { const v = ${V}; const c = v.camera; const P = v.map.provinces; const b = Conquest.ui.shell.bind; const { W, H } = Conquest.view.COUNTER; const r0 = document.querySelector('.cq-map').getBoundingClientRect();
    const all = v.counters().map((k) => { const [x, y] = c.toScreen(P[k.prov].x + 0.5, P[k.prov].y + 0.5); return { x: x + k.dx, y: y + k.dy, own: k.members.map((j) => b.groups[j]).filter((g) => g.side === 'own').flatMap((g) => g.divs), other: k.members.some((j) => b.groups[j].side !== 'own') }; });
    return all.filter((k) => k.own.length && !k.other && k.x > 80 && k.y > 80 && k.x < c.w - 80 && k.y < c.h - 80 && all.every((o) => o === k || Math.abs(o.x - k.x) > W * 2 + 12 || Math.abs(o.y - k.y) > H * 2 + 12)
      && document.elementFromPoint(r0.left + k.x, r0.top + k.y)?.closest('.cq-map')).map((k) => ({ x: r0.left + k.x, y: r0.top + k.y, divs: k.own })).slice(0, 2); })()`);
  // The map point at the centre of the view: a resize of the map (the army bar's height) keeps it, a pan moves it.
  const cam = () => js(`(() => { const c = ${V}.camera; const [mx, my] = c.toMap(c.w / 2, c.h / 2); return [Math.round(mx * 100) / 100, Math.round(my * 100) / 100, c.scale]; })()`);
  const drag = async (a, b, button = 'left', modifiers = 0) => {
    const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
    await mouse(ctx, 'mouseMoved', a.x, a.y, { modifiers });
    await mouse(ctx, 'mousePressed', a.x, a.y, { button, buttons, modifiers });
    for (let i = 1; i <= 8; i++) await mouse(ctx, 'mouseMoved', a.x + (b.x - a.x) * i / 8, a.y + (b.y - a.y) * i / 8, { button, buttons, modifiers });
    await mouse(ctx, 'mouseReleased', b.x, b.y, { button, buttons: 0, modifiers });
    await sleep(250);
  };
  const sorted = (a) => S([...a].sort((x, y) => x - y));
  if (lonely.length >= 2) {
    const [k1, k2] = lonely;
    const c0 = await cam();
    await drag({ x: k1.x - 22, y: k1.y - 18 }, { x: k1.x + 22, y: k1.y + 18 });
    const s1 = await js(`${G}.selection.divisions`);
    const c1 = await cam();
    await snapTo(ctx, 'stage4-select-dark.png');
    await drag({ x: k2.x - 22, y: k2.y - 18 }, { x: k2.x + 22, y: k2.y + 18 }, 'left', 8);
    const s2 = await js(`${G}.selection.divisions`);
    check(sorted(s1) === sorted(k1.divs) && sorted(s2) === sorted([...k1.divs, ...k2.divs]) && S(c0) === S(c1),
      `a left drag draws a box that selects exactly the player's stacks inside it without moving the map, and Shift adds the next box (${S({ s1: s1.length, want1: k1.divs.length, s2: s2.length, want2: k1.divs.length + k2.divs.length, moved: S(c0) !== S(c1) })})`);

    // The selection panel lists them; Halt and Direct Control mark them manual, Give Back hands them back.
    await until(`${shown('.cq-selpanel')} && Number(document.querySelector('.cq-selpanel').dataset.checked) > 0`, 'the selection panel', 5000).catch(() => {});
    const panel = await js(`(() => { const p = document.querySelector('.cq-selpanel'); return { count: Number(p.dataset.count), rows: [...p.querySelectorAll('.cq-sel-army')].map((r) => Number(r.dataset.count)), title: p.querySelector('.cq-sel-title').textContent,
      direct: p.querySelector('.cq-direct').disabled, back: p.querySelector('.cq-give-back').disabled, backWhy: p.querySelector('.cq-give-back').dataset.reason }; })()`);
    check(panel.count === s2.length && panel.rows.reduce((a, b) => a + b, 0) === s2.length && /divisions selected/.test(panel.title) && !panel.direct && panel.back && /direct control/.test(panel.backWhy),
      `the selection panel lists the selection by army, and Give Back is disabled with its reason while none is under direct control (${S(panel)})`);
    await ctx.click('.cq-selpanel .cq-direct');
    await until(`${S(s2)}.every((id) => ${G}.divs.get(id)?.manual === true)`, 'direct control of the selection', 8000).catch(() => {});
    const manual = await js(`${S(s2)}.map((id) => ${G}.divs.get(id)?.manual)`);
    await until(`document.querySelector('.cq-selpanel .cq-direct').disabled && !document.querySelector('.cq-selpanel .cq-give-back').disabled`, 'the panel after direct control', 5000).catch(() => {});
    const why = await js(`document.querySelector('.cq-selpanel .cq-direct').dataset.reason`);
    await ctx.click('.cq-selpanel .cq-give-back');
    await until(`${S(s2)}.every((id) => ${G}.divs.get(id)?.manual === false)`, 'handed back', 8000).catch(() => {});
    const back = await js(`${S(s2)}.map((id) => ${G}.divs.get(id)?.manual)`);
    await ctx.click('.cq-selpanel .cq-halt');
    await until(`${S(s2)}.every((id) => ${G}.divs.get(id)?.manual === true)`, 'halted', 8000).catch(() => {});
    const halted = await js(`${S(s2)}.map((id) => { const d = ${G}.divs.get(id); return d && d.manual && !(d.to > 0); })`);
    check(manual.every((m) => m === true) && /already/.test(why || '') && back.every((m) => m === false) && halted.every(Boolean),
      `Direct Control marks the selected divisions manual (then is disabled with its reason), Give Back hands them back and Halt stops them under direct control (${S({ manual, why, back, halted })})`);

    // A route preview on hover: an arrow per route and a tag with the latest arrival from the route query; a right click sends them all.
    const target = await js(`(() => { const g = ${G}; const P = g.map.provinces; const v = ${V}; const c = v.camera; const from = new Set(${S(s2)}.map((id) => g.divs.get(id).prov));
      const ok = (p) => { const [x, y] = c.toScreen(P[p].x + 0.5, P[p].y + 0.5); return x > 60 && y > 60 && x < c.w - 60 && y < c.h - 60 && v.provinceAt(Math.round(x), Math.round(y)) === p; };
      for (let p = 1; p < P.length; p++) if (!P[p].sea && g.prov.ctrl[p] === g.player && !from.has(p) && ok(p) && !P[p].adj.some((q) => g.nations[g.prov.ctrl[q]]?.war)) return p; return 0; })()`);
    if (target) {
      const tp = await anchor(ctx, target);
      await mouse(ctx, 'mouseMoved', tp.x, tp.y);
      await until(`document.querySelector('.cq-route-tag:not([hidden])')?.dataset.prov === '${target}'`, 'the route tag', 5000).catch(() => {});
      const want = await js(`(async () => { const g = ${G}; const seen = new Set(); let h = 0; for (const id of ${S(s2)}) { const d = g.divs.get(id); if (seen.has(d.prov)) continue; seen.add(d.prov); const r = await g.query('route', { div: id, to: ${target} }); if (r.path) h = Math.max(h, r.hours); } return h; })()`);
      const tag = await js(`(() => { const t = document.querySelector('.cq-route-tag'); return { ok: t.dataset.ok, hours: Number(t.dataset.hours), text: t.textContent, arrows: Conquest.ui.shell.bind && ${V}.borderLines && true }; })()`);
      await snapTo(ctx, 'stage4-route-dark.png');
      await clickAt(ctx, { x: tp.x + 3, y: tp.y + 3 }, 'right');
      await until(`${S(s2)}.every((id) => { const d = ${G}.divs.get(id); return d && (d.dest === ${target} || d.prov === ${target}); })`, 'the selection on its way', 8000).catch(() => {});
      const sent = await js(`${S(s2)}.map((id) => { const d = ${G}.divs.get(id); return d && (d.dest === ${target} || d.prov === ${target}); })`);
      const flash = await js(`document.querySelector('.cq-flash')?.dataset.prov ?? null`);
      check(tag.ok === 'true' && tag.hours === want && /hours/.test(tag.text) && sent.every(Boolean) && flash === String(target),
        `hovering a province previews the routes with the latest arrival from the route query, and a right click sends every selected division there with a confirmation at the target (${S({ tag, want, sent, flash })})`);
      // A refused move: hovering the sea says why in a red tag.
      const seaPt = await js(`(() => { const v = ${V}; const c = v.camera; const r = document.querySelector('.cq-map').getBoundingClientRect();
        for (let y = 60; y < c.h - 60; y += 17) for (let x = 60; x < c.w - 60; x += 17) { const id = v.provinceAt(x, y); if (id > 0 && v.map.provinces[id].sea && document.elementFromPoint(r.left + x, r.top + y)?.closest('.cq-map')) return { x: r.left + x, y: r.top + y, id }; } return null; })()`);
      if (seaPt) {
        await mouse(ctx, 'mouseMoved', seaPt.x, seaPt.y);
        await until(`document.querySelector('.cq-route-tag:not([hidden])')?.dataset.prov === '${seaPt.id}'`, 'the refused tag', 5000).catch(() => {});
        const refused = await js(`(() => { const t = document.querySelector('.cq-route-tag'); return { ok: t.dataset.ok, text: t.textContent, want: Conquest.ui.text.reason('sea'), tip: document.querySelector('.cq-tip')?.textContent || '' }; })()`);
        check(refused.ok === 'false' && refused.text === refused.want && refused.tip.includes(refused.want), `hovering where the selection cannot go says why, in a red tag and the tooltip (${S(refused)})`);
      } else check(false, 'a sea zone on screen to hover');
    } else check(false, 'a province of the player on screen to send the selection to');
  } else check(false, `two lone counters of the player on screen to box (${lonely.length})`);

  // Moving the map: a right drag, a middle drag and the arrow keys; the setting makes a left drag pan.
  await js(`(${G}.setSelection({ province: 0, divisions: [], army: null }), ${V}.camera.centerOn(${V}.map.texture.width / 2, ${V}.map.texture.height / 2, Math.max(${V}.camera.scale, 3)), ${V}.redraw(), document.activeElement?.blur?.(), true)`);
  await sleep(200);
  const mid = await js(`(() => { const r = document.querySelector('.cq-map').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  const moved = async (fn) => { const a = await cam(); await fn(); const b = await cam(); return [Math.round((b[0] - a[0]) * b[2]), Math.round((b[1] - a[1]) * b[2])]; };
  const right = await moved(() => drag(mid, { x: mid.x + 80, y: mid.y + 40 }, 'right'));
  const middle = await moved(() => drag(mid, { x: mid.x - 60, y: mid.y - 30 }, 'middle'));
  const leftSel = await moved(() => drag(mid, { x: mid.x + 70, y: mid.y + 30 }));
  const key = await moved(async () => { await ctx.press('ArrowLeft'); await sleep(100); });
  await js(`(ide.settings.set('conquest.leftDrag', 'pan'), true)`);
  const selBefore = await js(`${G}.selection.divisions.length`);
  const leftPan = await moved(() => drag(mid, { x: mid.x + 70, y: mid.y + 30 }));
  const selAfter = await js(`${G}.selection.divisions.length`);
  await js(`(ide.settings.set('conquest.leftDrag', 'select'), true)`);
  check(right[0] === -80 && right[1] === -40 && middle[0] === 60 && middle[1] === 30 && leftSel[0] === 0 && leftSel[1] === 0 && key[0] === -120 && key[1] === 0 && leftPan[0] === -70 && leftPan[1] === -30 && selBefore === selAfter,
    `a right or middle drag and the arrow keys move the map, a left drag does not, and with the setting on "move the map" a left drag pans (${S({ right, middle, leftSel, key, leftPan })})`);

  // Drawing a front: the border edges it will hold, between the camps, while the pointer moves; Enter sets it.
  const contact = await js(CONTACT());
  if (contact.chain.length >= 2) {
    await js(`(${G}.setSelection({ army: ${army}, divisions: [], province: 0 }), true)`);
    await frame(ctx, contact.chain, 0.4);
    await ctx.click('.cq-draw-front');
    await clickAt(ctx, await anchor(ctx, contact.chain[0]));
    const p2 = await anchor(ctx, contact.chain[1]);
    await mouse(ctx, 'mouseMoved', p2.x, p2.y);
    await until(`!!${V}.borderLines.find((l) => l.preview) && /2 provinces/.test(document.querySelector('.cq-plan-hint')?.textContent || '')`, 'the front preview', 5000).catch(() => {});
    const pre = await js(`(() => { const g = ${G}; const v = ${V}; const c = v.camera; const line = v.borderLines.find((l) => l.preview); const camp = (n) => n >= 0 && (n === g.player || !!g.nations[n]?.ally); const foe = (n) => n >= 0 && n !== g.player && !!g.nations[n]?.war;
      const at = (x, y) => g.prov.ctrl[v.provinceAt(...c.toScreen(x, y))] ?? -1; let n = 0; let bad = 0; const chain = ${S(contact.chain.slice(0, 2))}; let near = 0;
      for (const path of line?.paths || []) for (let i = 0; i < path.length; i += 2) { const x = path[i], y = path[i + 1]; n++; const ids = [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]].map(([dx, dy]) => v.provinceAt(...c.toScreen(x + dx, y + dy)));
        const cs = ids.map((id) => g.prov.ctrl[id] ?? -1); if (!cs.some(camp) || !cs.some(foe)) bad++; if (ids.some((id) => chain.includes(id))) near++; }
      const hint = document.querySelector('.cq-plan-hint'); return { n, bad, near, pairs: line?.pairs.length || 0, hint: hint && !hint.hidden ? hint.textContent : null }; })()`);
    await snapTo(ctx, 'stage4-draw-dark.png');
    await clickAt(ctx, p2);
    await ctx.press('Enter');
    await sleep(400);
    const front = await js(`${G}.me.armies.find((a) => a.id === ${army}).front || []`);
    const gone = await js(`!${V}.borderLines.some((l) => l.preview) && document.querySelector('.cq-plan-hint').hidden`);
    check(pre.n > 2 && !pre.bad && pre.near === pre.n && /Enter sets the front/.test(pre.hint || '') && S(front) === S(contact.chain.slice(0, 2)) && gone,
      `drawing a front previews the border edges it will hold between the camps, says what Enter and Esc do, and Enter sets the army's front (${S({ pre, front })})`);

    // An offensive: the odds of its first battle from the attackOdds query; Escape cancels the drawing.
    // An enemy province next to the front, a held one first, so the hint has odds to show.
    const first = await js(`(() => { const g = ${G}; const P = g.map.provinces; const held = new Set([...g.divs.values()].filter((d) => g.nations[d.nation]?.war).map((d) => d.prov)); let any = 0;
      for (const p of ${S(contact.chain)}) for (const q of P[p].adj) if (!P[q].sea && g.nations[g.prov.ctrl[q]]?.war) { if (held.has(q)) return q; any = any || q; } return any; })()`);
    await ctx.click('.cq-draw-offensive');
    await clickAt(ctx, await anchor(ctx, first));
    await until(`!!document.querySelector('.cq-plan-hint[data-kind="offensive"]') && /First battle|no defenders|No division/.test(document.querySelector('.cq-plan-hint').textContent)`, 'the odds', 6000).catch(() => {});
    const q = await js(`${G}.query('attackOdds', { army: ${army}, prov: ${first} })`);
    const hint = await js(`({ odds: document.querySelector('.cq-plan-hint').dataset.odds ?? null, text: document.querySelector('.cq-plan-hint').textContent })`);
    await ctx.press('Escape');
    const cancelled = await js(`!Conquest.ui.command.drawing && document.querySelector('.cq-plan-hint').hidden`);
    check(q && (!q.attackers ? /No division/.test(hint.text) : !q.defenders ? /has no defenders/.test(hint.text) : hint.odds === String(q.odds) && /First battle/.test(hint.text)) && cancelled,
      `drawing an offensive shows its first battle's odds from the attackOdds query, and Escape cancels the drawing (${S({ q, hint })})`);
  } else check(false, `the player has a contact line to draw on (${S(contact)})`);

  // The minimap: its rectangle follows the camera and a click on it moves the view there.
  const MINI = `(() => { const m = document.querySelector('.cq-minimap'); const cv = m.querySelector('.cq-minimap-map').getBoundingClientRect(); const r = m.querySelector('.cq-minimap-view').getBoundingClientRect(); const c = ${V}.camera; const k = cv.width / ${V}.map.texture.width;
    return { shown: ${shown('.cq-minimap-map')}, cv: { x: cv.left, y: cv.top, w: cv.width }, rect: [r.left - cv.left, r.top - cv.top, r.width, r.height].map((v) => Math.round(v)), want: [Math.max(0, c.x) * k, Math.max(0, c.y) * k, (Math.min(${V}.map.texture.width, c.x + c.w / c.scale) - Math.max(0, c.x)) * k, (Math.min(${V}.map.texture.height, c.y + c.h / c.scale) - Math.max(0, c.y)) * k].map((v) => Math.round(v)), painted: Conquest.ui.minimap.painted }; })()`;
  await js(`(${V}.camera.centerOn(${V}.map.texture.width * 0.3, ${V}.map.texture.height * 0.4, Math.max(${V}.camera.minScale * 3, 1)), ${V}.redraw(), true)`);
  await sleep(300);
  const m1 = await js(MINI);
  await js(`(${V}.pan(-150, -60), true)`);
  await sleep(300);
  const m2 = await js(MINI);
  const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 2);
  const pt = { x: Math.round(m2.cv.x + m2.cv.w * 0.6), y: Math.round(m2.cv.y + 20) };
  await clickAt(ctx, pt);
  const after = await js(`(() => { const c = ${V}.camera; const [mx, my] = c.toMap(c.w / 2, c.h / 2); return { mx, my, want: [(${pt.x} - ${m2.cv.x}) / ${m2.cv.w} * ${V}.map.texture.width, (${pt.y} - ${m2.cv.y}) / ${m2.cv.w} * ${V}.map.texture.width], clampedY: c.y <= 0.01 || c.y + c.h / c.scale >= ${V}.map.texture.height - 0.01 }; })()`);
  check(m1.shown && m1.painted > 0 && close(m1.rect, m1.want) && close(m2.rect, m2.want) && S(m1.rect) !== S(m2.rect) && Math.abs(after.mx - after.want[0]) < 3 && (Math.abs(after.my - after.want[1]) < 3 || after.clampedY),
    `the minimap's rectangle follows the camera, and a click on the minimap centres the map there (${S({ m1: m1.rect, w1: m1.want, m2: m2.rect, w2: m2.want, after })})`);
  void P0;
}

try {
  // ---------- the 1914 world as France ----------
  {
    const ctx = await launch({ fixture: 'core', port: 9838, name: 'conquest-game', mode: 'conquest', env });
    const { js, until } = ctx;
    await until('window.__conquestReady === true', 'the start screen map', 90000);
    await js(`(ide.settings.set('conquest.guideDone', true), true)`);
    const start = await js(`({ start: ${shown('.cq-start')}, game: ${G}.status, majors: [...document.querySelectorAll('.cq-major')].map((b) => b.dataset.tag), picked: document.querySelector('.cq-picked')?.dataset.tag,
      text: document.querySelector('.cq-picked-text')?.textContent, armybar: ${shown('.cq-armybar')} })`);
    check(start.start && start.game === 'none' && start.majors.includes('FRA') && start.majors.includes('DEU') && !start.armybar && start.text?.length > 20,
      `the window opens on the start screen with the great powers listed and France described (${S(start)})`);
    // Pick Germany by clicking Berlin's province on the map, then France from the list.
    const deuCapital = await js(`(async () => (await Conquest.game.loadWorld()).scenario.nations.find((n) => n.tag === 'DEU').capital)()`);
    await js(`(${V}.focus(${deuCapital}), true)`);
    await sleep(200);
    await clickAt(ctx, await anchor(ctx, deuCapital));
    const pickedDeu = await js(`document.querySelector('.cq-picked')?.dataset.tag`);
    check(pickedDeu === 'DEU', `a click on the map picks the nation that owns the province (${pickedDeu})`);
    await ctx.click('.cq-major[data-tag="FRA"]');
    check((await js(`document.querySelector('.cq-picked')?.dataset.tag`)) === 'FRA', 'the France button picks France');
    await ctx.click('.cq-start-game');
    await until(`${G}.running`, 'the game starts', 90000);
    await sleep(400);
    const g0 = await js(`({ date: document.querySelector('.cq-date').textContent, nation: document.querySelector('.cq-nation').textContent, speed: ${G}.speed, hour: ${G}.hour,
      start: ${shown('.cq-start')}, armies: document.querySelectorAll('.cq-army').length, divs: ${G}.divs.size, tag: ${G}.scenario.nations[${G}.player].tag })`);
    check(g0.tag === 'FRA' && g0.nation === 'France' && /^28 June 1914/.test(g0.date) && g0.hour === 0 && g0.speed === 0 && !g0.start && g0.armies >= 5 && g0.divs > 300,
      `a new 1914 game as France starts paused on 28 June 1914 with its armies in the army bar (${S(g0)})`);

    // Space and the speed keys; the date moves only while the game runs.
    await clickAt(ctx, await pagePoint(ctx, ...(await js(`${V}.camera.toMap(${V}.camera.w / 2, ${V}.camera.h / 2)`))));
    await ctx.press('Space');
    const s1 = await js(`${G}.speed`);
    await sleep(2500);
    const h1 = await js(`${G}.hour`);
    await ctx.press('Space');
    const s2 = await js(`${G}.speed`);
    const h2 = await js(`${G}.hour`);
    await sleep(1500);
    const h3 = await js(`${G}.hour`);
    check(s1 > 0 && h1 > 0 && s2 === 0 && h3 === h2, `Space runs and pauses the game, and the date moves only while it runs (speed ${s1} -> ${s2}, hours ${h1}, ${h2}, ${h3})`);
    await ctx.press('5');
    const k5 = await js(`${G}.speed`);
    await ctx.press('-');
    const k4 = await js(`${G}.speed`);
    await ctx.press('Shift+=');
    const kp = await js(`${G}.speed`);
    await ctx.press('2');
    const k2 = await js(`${G}.speed`);
    await ctx.press('Space');
    const shownDate = await text(ctx, '.cq-date');
    const dateNow = await js(`Conquest.ui.text.date(${G}.date(), true)`);
    check(k5 === 5 && k4 === 4 && kp === 5 && k2 === 2 && (await js(`${G}.speed`)) === 0 && shownDate === dateNow, `5, -, + and 2 set the speed, the top bar shows the hour (${S([k5, k4, kp, k2, shownDate])})`);

    // The province card of a French province with divisions in it, against the province query.
    const fp = await js(`(() => { const g = ${G}; for (const d of g.divs.values()) if (d.nation === g.player && !g.map.provinces[d.prov].sea) return d.prov; return 0; })()`);
    await js(`(${V}.focus(${fp}), ${V}.zoom(2), true)`);
    await sleep(250);
    const pa = await anchor(ctx, fp);
    await clickAt(ctx, { x: pa.x + 1, y: pa.y + 30 });
    let sel = await js(`${G}.selection.province`);
    if (sel !== fp) { await clickAt(ctx, pa); sel = await js(`${G}.selection.province`); }
    await until(`${shown('.cq-card')} && document.querySelector('.cq-card').dataset.province === '${sel}'`, 'the province card', 10000);
    const q = await js(`${G}.query('province', { id: ${sel} })`);
    const cardShown = await js(`({ name: document.querySelector('.cq-card-name').textContent, facts: [...document.querySelectorAll('.cq-fact')].map((f) => [f.children[0].textContent, f.children[1].textContent]), rows: Number(document.querySelector('.cq-card').dataset.divisions) })`);
    const fact = (k) => cardShown.facts.find((f) => f[0] === k)?.[1];
    check(sel > 0 && cardShown.name === q.name && fact('Owner') === 'France' && fact('Terrain') === (await js(`Conquest.ui.text.terrain(${S(q.terrain)})`)) && fact('Supply') === String(q.supply)
      && fact('Infrastructure') === String(q.infra) && cardShown.rows === q.divisions.length,
      `clicking a province shows its card with the province query's data (${S({ name: q.name, terrain: q.terrain, supply: q.supply, divs: q.divisions.length, card: cardShown })})`);
    // The explaining facts show the shared tooltip on hover (ui/tip.js); its note is also the fact's data-note.
    const factTip = async (k) => {
      const at = await js(`(() => { const f = [...document.querySelectorAll('.cq-fact')].find((x) => x.children[0].textContent === ${S(k)}); if (!f) return null; const r = f.children[0].getBoundingClientRect(); return { x: r.left + 4, y: r.top + r.height / 2, note: f.dataset.note ?? null }; })()`);
      if (!at) return null;
      await mouse(ctx, 'mouseMoved', at.x, at.y);
      await until(`${shown('.cq-stat-tip')} && document.querySelector('.cq-stat-tip').dataset.stat.startsWith('fact-')`, `the ${k} tooltip`, 5000).catch(() => {});
      const shownTip = await js(`({ head: document.querySelector('.cq-stat-tip .cq-tip-head')?.textContent, note: document.querySelector('.cq-stat-tip .cq-tip-note')?.textContent, rows: [...document.querySelectorAll('.cq-stat-tip .cq-tip-row')].map((r) => [r.dataset.k, Number(r.dataset.v)]), shown: ${shown('.cq-stat-tip')} })`);
      await mouse(ctx, 'mouseMoved', 5, 300);
      return { ...shownTip, data: at.note };
    };
    const trenchTip = `Until the trenches reach ${q.trench}, attackers who win a battle here take the province within the hour.`;
    const tt = await factTip('Trenches');
    check(q.trench === 300 && Number.isInteger(q.works) && fact('Trenches') === (q.dug ? `Dug in (${q.works})` : `Shallow (${q.works} of ${q.trench})`) && tt?.shown && tt.head === 'Trenches' && tt.note.startsWith(trenchTip) && tt.data === tt.note
      && S(tt.rows) === S([['works', q.works], ['need', q.trench]]),
      `the card says whether the province is dug in, with its works and the threshold, and hovering it says what that means (${S({ works: q.works, dug: q.dug, fact: fact('Trenches'), tip: tt })})`);
    const st = await factTip('Supply');
    const it = await factTip('Infrastructure');
    check(st?.shown && /organisation/.test(st.note) && st.rows[0]?.[1] === q.supply && it?.shown && /railways/.test(it.note) && it.rows[0]?.[1] === q.infra && !(await js(shown('.cq-stat-tip'))),
      `hovering the Supply and Infrastructure facts says what the number means and changes, and leaving hides it (${S({ supply: st, infra: it })})`);
    const armyTip = await js(`(() => { const s = document.querySelector('.cq-army .cq-army-org'); if (!s) return null; const r = s.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (armyTip) await mouse(ctx, 'mouseMoved', armyTip.x, armyTip.y);
    await until(`document.querySelector('.cq-stat-tip')?.dataset.stat === 'army-org'`, 'the army org tooltip', 5000).catch(() => {});
    const at2 = await js(`({ stat: document.querySelector('.cq-stat-tip')?.dataset.stat, note: document.querySelector('.cq-stat-tip .cq-tip-note')?.textContent })`);
    await mouse(ctx, 'mouseMoved', 5, 300);
    check(at2.stat === 'army-org' && /breaks and falls back/.test(at2.note || ''), `hovering an army card's org says what organisation does (${S(at2)})`);

    // A division of an army with no general: its detail says so once, not "general No general" (found playing France).
    const lone = await js(`(() => { const g = ${G}; const a = g.me.armies.find((x) => !x.general && x.divs.length); if (!a) return null; const d = g.divs.get(a.divs[0]); return d && { div: d.id, prov: d.prov, army: a.name }; })()`);
    if (lone) {
      await js(`(${G}.setSelection({ province: ${lone.prov} }), ${V}.setSelected(${lone.prov}), true)`);
      await until(`!!document.querySelector('.cq-card .cq-div-row[data-div="${lone.div}"]')`, 'the row of a division with no general', 8000).catch(() => {});
      await js(`document.querySelector('.cq-card .cq-div-row[data-div="${lone.div}"]')?.scrollIntoView({ block: 'nearest' }), true`);
      await ctx.click(`.cq-card .cq-div-row[data-div="${lone.div}"]`);
      await until(`!!document.querySelector('.cq-card .cq-div-detail .cq-dd-army')`, 'its detail', 5000).catch(() => {});
      const line = await js(`document.querySelector('.cq-card .cq-div-detail .cq-dd-army')?.textContent ?? null`);
      check(line === `${lone.army}, no general`, `the detail of a division whose army has no general says "${lone.army}, no general" (${S({ line })})`);
      await js(`(${G}.setSelection({ province: 0 }), ${V}.setSelected(0), true)`);
    } else check(false, 'France has an army with no general (Armée des Alpes)');
    // France starts with every military factory on a line: the guide's factories step says how to free one.
    await ctx.click('.cq-help');
    for (let i = 0; i < 8 && (await js(`Conquest.ui.guide.step`)) !== 'factories' && (await js(`Conquest.ui.guide.step`)); i++) { await ctx.click('.cq-guide-skip'); await sleep(150); }
    const fstep = await js(`(async () => ({ step: Conquest.ui.guide.step, text: document.querySelector('.cq-guide-text')?.textContent, free: (await ${G}.query('economy')).free }))()`);
    check(fstep.step === 'factories' && fstep.free === 0 && /Press − on a line to free one/.test(fstep.text || ''), `with no free military factory the guide's factories step says to free one with − first (${S(fstep)})`);
    await ctx.click('.cq-guide-close');
    // Dates follow the simulation's 365-day calendar: no 29 February 1916, and the game's last day is 1 January 1920.
    const days = await js(`[Conquest.ui.text.date(${G}.date(611 * 24)), Conquest.ui.text.date(${G}.date((6 * 365 - 178) * 24))]`);
    check(S(days) === S(['1 March 1916', '1 January 1920']), `the dates on screen follow the game's calendar: day 611 is 1 March 1916 and day 2012 is 1 January 1920 (${S(days)})`);

    // Pause on alerts: offers no longer pause, a declaration of war does; the alert focuses the map.
    await ctx.click('.cq-alerts-gear');
    await until(shown('.cq-pause-pop'), 'the pause settings', 5000);
    const offerOn = await js(`document.querySelector('.cq-pause-row input[data-kind="offer"]').checked`);
    if (offerOn) await ctx.click('.cq-pause-row input[data-kind="offer"]');
    const pauses = await js(`({ offer: document.querySelector('.cq-pause-row input[data-kind="offer"]').checked, war: document.querySelector('.cq-pause-row input[data-kind="war"]').checked, saved: ide.settings.get('conquest.pauseOn', {}) })`);
    check(!pauses.offer && pauses.war && pauses.saved.offer === false, `the pause settings turn pausing on an offer off and keep war on (${S(pauses)})`);
    await ctx.click('.cq-alerts-gear');
    const warred = await runUntil(ctx, `[...document.querySelectorAll('.cq-alert')].some((a) => a.dataset.kind === 'war')`, 'a declaration of war on France', 24 * 60);
    const wr = await js(`({ speed: ${G}.speed, hour: ${G}.hour, alert: [...document.querySelectorAll('.cq-alert')].find((a) => a.dataset.kind === 'war')?.textContent, enemies: ${G}.nations.filter((n) => n.war).map((n) => n.tag) })`);
    const pausedBy = await js(`(() => { const w = ${G}.log.filter((e) => e.kind === 'war' && (e.a === ${G}.player || e.b === ${G}.player)); return w.length ? w[w.length - 1] : null; })()`);
    check(warred && wr.enemies.length > 0, `driving time forward, war comes to France and an alert says so (${S(wr)})`);
    const pausedAt = await js(`${G}.hour`);
    await sleep(800);
    check(warred && (await js(`${G}.speed`)) === 0 && (await js(`${G}.hour`)) === pausedAt, `the war alert paused the game (speed ${wr.speed} at hour ${wr.hour})`);
    await until(`${G}.me.armies.some((a) => a.front && Conquest.ui.staff.isStaff(a.id)) && !Conquest.ui.staff.busy`, 'the staff fronts at the declaration', 8000);
    const staff0 = await js(`({ fronts: ${G}.me.armies.filter((a) => a.front && Conquest.ui.staff.isStaff(a.id)).map((a) => [a.id, a.front.join(',')]), alerts: Conquest.ui.shell.alertCounts().staff || 0 })`);
    // The line moves: an enemy takes a province of a staff front. Within a game day the staff plans its armies again.
    const lost = await js(`(() => { const g = ${G}; const P = g.map.provinces; const me = g.player; const busy = new Set(); for (const d of g.divs.values()) busy.add(d.prov);
      for (const a of g.me.armies) { if (!a.front || !Conquest.ui.staff.isStaff(a.id)) continue;
        for (const p of a.front) { const e = P[p].adj.find((q) => !P[q].sea && g.prov.ctrl[q] >= 0 && g.nations[g.prov.ctrl[q]]?.war); if (e && g.prov.ctrl[p] === me && !busy.has(p) && p !== g.scenario.nations[me].capital) return { p, enemy: g.prov.ctrl[e], me }; } }
      return null; })()`);
    if (lost) {
      await setState(ctx, [{ path: ['prov', 'ctrl', lost.p], value: lost.enemy }]);
      for (let i = 0; i < 3 && !(await js(`${G}.me.armies.some((a) => { const was = new Map(${S(staff0.fronts)}); return was.has(a.id) && a.front && a.front.join(',') !== was.get(a.id); })`)); i++) { await runFor(ctx, 24, 4); await sleep(600); }
      const staff1 = await js(`({ fronts: ${G}.me.armies.filter((a) => a.front && Conquest.ui.staff.isStaff(a.id)).map((a) => [a.id, a.front.join(',')]), alerts: Conquest.ui.shell.alertCounts().staff || 0, stale: ${G}.me.armies.filter((a) => a.front && Conquest.ui.staff.isStaff(a.id) && a.front.includes(${lost.p})).length })`);
      const moved = staff0.fronts.filter(([id, fr]) => { const now = staff1.fronts.find((x) => x[0] === id); return now && now[1] !== fr; }).length;
      check(moved > 0 && staff1.stale === 0 && staff1.alerts === staff0.alerts, `when the enemy takes a province of a staff front, the staff plans its armies again within a game day, without a new alert (${S({ lost, armies: staff0.fronts.length, moved, stale: staff1.stale, alerts: [staff0.alerts, staff1.alerts] })})`);
      if ((await js(`${G}.prov.ctrl[${lost.p}]`)) === lost.enemy) await setState(ctx, [{ path: ['prov', 'ctrl', lost.p], value: lost.me }]);
    } else check(false, `a staff front province next to the enemy with no division in it (${S(staff0)})`);
    if (pausedBy) {
      const foe = pausedBy.a === (await js(`${G}.player`)) ? pausedBy.b : pausedBy.a;
      const foeCapital = await js(`${G}.scenario.nations[${foe}].capital`);
      await js(`(${V}.camera.fit(), ${V}.redraw(), true)`);
      await ctx.click('.cq-alert[data-kind="war"] .cq-alert-main');
      await sleep(300);
      const f = await js(`(() => { const c = ${V}.camera; const p = ${V}.map.provinces[${foeCapital}]; const [x, y] = c.toScreen(p.x, p.y); return { selected: ${V}.selected, sel: ${G}.selection.province, dx: Math.abs(x - c.w / 2), dy: Math.abs(y - c.h / 2) }; })()`);
      check(f.selected === foeCapital && f.sel === foeCapital && f.dx < 40 && f.dy < 40, `clicking the war alert centres the map on the enemy capital and selects it (${S(f)})`);
    } else check(false, 'the log has the declaration of war that raised the alert');

    // A province whose controller changed is drawn in its controller's colour, tinted toward its owner.
    await runUntil(ctx, `(() => { const g = ${G}; for (let p = 1; p < g.prov.ctrl.length; p++) if (g.prov.ctrl[p] >= 0 && g.prov.owner[p] >= 0 && g.prov.ctrl[p] !== g.prov.owner[p] && g.map.provinces[p].area > 3000) return true; return false; })()`, 'an occupied province', 24 * 40);
    const occ = await js(`(() => { const g = ${G}; let best = 0; for (let p = 1; p < g.prov.ctrl.length; p++) if (g.prov.ctrl[p] >= 0 && g.prov.owner[p] >= 0 && g.prov.ctrl[p] !== g.prov.owner[p] && (!best || g.map.provinces[p].area > g.map.provinces[best].area)) best = p;
      return best ? { id: best, owner: g.prov.owner[best], ctrl: g.prov.ctrl[best] } : null; })()`);
    if (occ) {
      await js(`(${V}.setMode('political'), ${V}.setSelected(0), ${V}.focus(${occ.id}), ${V}.zoom(2.5), true)`);
      await mouse(ctx, 'mouseMoved', 5, 5);
      await sleep(300);
      // A point of the province clear of its borders and of the counters, markers and arrows at its anchor.
      const spot = await js(`(() => { const v = ${V}; const c = v.camera; const p = v.map.provinces[${occ.id}]; const [ax, ay] = c.toScreen(p.x + 0.5, p.y + 0.5);
        for (let r = 30; r < 220; r += 6) for (let a = 0; a < 16; a++) { const x = ax + Math.cos(a * Math.PI / 8) * r; const y = ay + Math.abs(Math.sin(a * Math.PI / 8)) * r + 20;
          if (x < 20 || y < 20 || x > c.w - 20 || y > c.h - 20) continue;
          const r0 = document.querySelector('.cq-map').getBoundingClientRect(); if (!document.elementFromPoint(r0.left + x, r0.top + y)?.closest('.cq-map')) continue;
          if ([[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6]].every(([dx, dy]) => v.provinceAt(x + dx, y + dy) === p.id)) return { lx: x, ly: y }; }
        return null; })()`);
      const want = await js(`(() => { const g = ${G}; const c = g.scenario.nations.map((n) => n.color); return [Conquest.view.mixHex(c[${occ.ctrl}], c[${occ.owner}], 0.35), c[${occ.owner}]]; })()`);
      const px = spot ? (await js(`${V}.sample([[${spot.lx}, ${spot.ly}]])`))[0] : null;
      const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
      const near = (a, b, d) => a && a.every((v, i) => Math.abs(v - b[i]) <= d);
      check(px && near(px, hex(want[0]), 4) && !near(px, hex(want[1]), 12), `an occupied province is drawn in its controller's colour tinted toward its owner (${S({ occ, px, want })})`);
    } else check(false, 'some province changed controller in the first weeks of the war');

    const fighting = await runUntil(ctx, `${G}.battles.length > 0`, 'a battle', 24 * 20);
    if (fighting) {
      const bp = await js(`${G}.battles[0].prov`);
      await js(`(${G}.setSelection({ province: ${bp} }), ${V}.setSelected(${bp}), true)`);
      await until(`document.querySelector('.cq-card')?.dataset.province === '${bp}'`, 'the battle card', 8000);
      await sleep(400);
      const bq = await js(`${G}.query('province', { id: ${bp} })`);
      const shownB = await js(`({ fact: [...document.querySelectorAll('.cq-fact')].find((f) => f.children[0].textContent === 'Battle')?.children[1].textContent,
        rows: [...document.querySelectorAll('.cq-card-divs .cq-div-row')].map((r) => [Number(r.dataset.div), !!r.querySelector('.cq-div-line')]) })`);
      const standing = bq.battle ? bq.battle.line.filter((id) => bq.divisions.some((d) => d.id === id)).length : -1;
      check(bq.battle && bq.battle.lineMax === 6 && shownB.fact && shownB.fact.endsWith(`; ${standing} of 6 divisions in the defending line`),
        `the battle fact says how many divisions stand in the defending line out of six (${S({ fact: shownB.fact, line: bq.battle && bq.battle.line })})`);
      check(bq.battle && shownB.rows.length > 0 && shownB.rows.every(([id, tagged]) => tagged === bq.battle.line.includes(id)) && (standing === 0 || shownB.rows.some(([, tagged]) => tagged)),
        `the card marks exactly the divisions of the defending line (${S(shownB.rows.slice(0, 12))})`);
      await js(`(${G}.setSelection({ province: 0 }), ${V}.setSelected(0), true)`);

      // A battle marker at every battle, with the player's side's mirrored odds; a real click on one selects its province.
      const marks = await js(`(() => { const g = ${G}; const camp = (c) => c >= 0 && (c === g.player || !!g.nations[c]?.ally);
        const want = g.battles.map((b) => { const a = camp(b.side); const d = camp(g.prov.ctrl[b.prov]); return a === d ? { prov: b.prov, odds: b.odds, mine: false } : { prov: b.prov, odds: a ? b.odds : 1000 - b.odds, mine: true }; });
        const got = ${V}.markers.map((m) => ({ prov: m.prov, odds: m.odds, mine: m.mine }));
        const ours = g.battles.filter((b) => camp(b.side) !== camp(g.prov.ctrl[b.prov]));
        return { want, got, ours: ours.map((b) => b.prov) }; })()`);
      check(marks.want.length > 0 && S(marks.got) === S(marks.want), `every battle has a marker at its province with the player's side's odds (${marks.got.length} markers, ${S(marks.got.slice(0, 4))})`);
      const mp = marks.ours[0] ?? marks.want[0]?.prov;
      if (mp) {
        await js(`(${V}.focus(${mp}), ${V}.camera.centerOn(${V}.map.provinces[${mp}].x, ${V}.map.provinces[${mp}].y, 3), ${V}.redraw(), true)`);
        await sleep(250);
        const pt = await js(`(() => { const m = ${V}.markers.find((x) => x.prov === ${mp}); const [x, y] = ${V}.markerPoint(m); const r = document.querySelector('.cq-map').getBoundingClientRect();
          return { x: r.left + x, y: r.top + y, onMap: !!document.elementFromPoint(r.left + x, r.top + y)?.closest('.cq-map'), under: ${V}.provinceAt(x, y), trend: Conquest.view.oddsTrend(m.odds), odds: m.odds }; })()`);
        await clickAt(ctx, pt);
        await until(`document.querySelector('.cq-card')?.dataset.province === '${mp}'`, 'the card of the marker', 5000).catch(() => {});
        const sel = await js(`({ sel: ${G}.selection.province, view: ${V}.selected, card: document.querySelector('.cq-card')?.dataset.province })`);
        check(pt.onMap && sel.sel === mp && sel.view === mp && sel.card === String(mp), `a real click on a battle marker selects the battle's province and opens its card (${S({ ...pt, ...sel, battle: mp })})`);
        await battleWindow(ctx, mp, pt);
        await js(`(${G}.setSelection({ province: 0 }), ${V}.setSelected(0), true)`);
      }
    } else check(false, 'a battle is fought in the first weeks of the war');

    // An army's front and offensive on the German border, drawn with real clicks; then the screenshots.
    const deuIndex = await js(`${G}.scenario.nations.findIndex((n) => n.tag === 'DEU')`);
    const border = await js(CONTACT(deuIndex));
    const armyId = await js(`(() => { const g = ${G}; const P = g.map.provinces; const t = P[${S(border.chain[0] || 0)}] || P[1];
      let best = null; let bd = Infinity; for (const a of g.me.armies) for (const id of a.divs) { const d = g.divs.get(id); if (!d) continue; const q = P[d.prov]; const dd = (q.x - t.x) ** 2 + (q.y - t.y) ** 2; if (dd < bd) { bd = dd; best = a.id; } } return best; })()`);
    if (border.chain.length >= 2 && armyId) {
      await js(`(${G}.setSelection({ army: null, divisions: [] }), true)`);
      await ctx.click(`.cq-army[data-army="${armyId}"]`);
      await sleep(200);
      const chosen = await js(`({ sel: ${G}.selection.army, active: document.querySelector('.cq-army.active')?.dataset.army })`);
      await frame(ctx, [...border.chain, border.enemyNext]);
      await ctx.click('.cq-draw-front');
      for (const id of border.chain) await clickAt(ctx, await anchor(ctx, id));
      const drawn = await js(`Conquest.ui.command.drawing`);
      const t0 = Date.now();
      await ctx.press('Enter');
      await until(`!!${G}.me.armies.find((a) => a.id === ${armyId}).front || ${shown('.cq-toast')}`, 'the front order answered', 10000).catch(() => {});
      await sleep(300);
      const front = await js(`${G}.me.armies.find((a) => a.id === ${armyId}).front`);
      const waited = Date.now() - t0;
      const told = await text(ctx, '.cq-toast');
      await ctx.click('.cq-draw-offensive');
      const deep = await js(`(() => { const P = ${G}.map.provinces; const g = ${G}; let p = ${border.enemyNext}; for (let i = 0; i < 2; i++) { const n = P[p].adj.find((q) => !P[q].sea && g.prov.ctrl[q] === ${deuIndex} && !P[q].adj.includes(${border.chain[0]})); if (n) p = n; } return p; })()`);
      await frame(ctx, [...border.chain, border.enemyNext, deep]);
      for (const id of [border.enemyNext, deep]) await clickAt(ctx, await anchor(ctx, id));
      await ctx.press('Enter');
      await sleep(400);
      const plan = await js(`(() => { const a = ${G}.me.armies.find((x) => x.id === ${armyId}); return { front: a.front, offensives: a.offensives }; })()`);
      check(String(chosen.sel) === String(armyId) && chosen.active === String(armyId) && Array.isArray(front) && border.chain.every((p) => front.includes(p))
        && plan.offensives.length === 1 && plan.offensives[0].path[0] === border.enemyNext && plan.offensives[0].path.includes(deep),
        `on the French border an army is selected and a front and an offensive are drawn with real clicks (${S({ chosen, chain: border.chain, drawn, told, waited, front, offensive: plan.offensives[0] })})`);

      // The war front and the army's front run along real province edges between hostile controllers.
      await sleep(600);
      const ON_BORDER = `((line) => { const g = ${G}; const v = ${V}; const c = v.camera; const camp = (n) => n >= 0 && (n === g.player || !!g.nations[n]?.ally); const foe = (n) => n >= 0 && n !== g.player && !!g.nations[n]?.war;
        const at = (x, y) => g.prov.ctrl[v.provinceAt(...c.toScreen(x, y))] ?? -1; let n = 0; const bad = [];
        for (const path of line.paths) for (let i = 0; i < path.length; i += 2) { const x = path[i], y = path[i + 1]; n++;
          const cs = [at(x - 0.5, y - 0.5), at(x + 0.5, y - 0.5), at(x - 0.5, y + 0.5), at(x + 0.5, y + 0.5)]; if (!cs.some(camp) || !cs.some(foe)) bad.push([x, y, cs]); }
        return { n, bad: bad.slice(0, 4), badCount: bad.length }; })`;
      const fronts = await js(`(() => { const b = Conquest.ui.shell.bind; const v = ${V}; const lines = v.borderLines;
        const war = lines.find((l) => l.army === undefined); const mine = lines.find((l) => l.army === ${armyId});
        return { pairs: b.warPairs.length, war: war && ${ON_BORDER}(war), army: mine && { ...${ON_BORDER}(mine), color: mine.color, want: Conquest.ui.armyColor(${armyId}), width: mine.width, last: lines[lines.length - 1].army,
          others: lines.filter((l) => l.army !== undefined && l.army !== ${armyId}).map((l) => l.width) },
          swatch: getComputedStyle(document.querySelector('.cq-army[data-army="${armyId}"] .cq-army-name'), '::before').backgroundColor }; })()`);
      check(fronts.pairs > 10 && fronts.war && fronts.war.n > 20 && !fronts.war.badCount, `the war front is drawn along the real border between provinces of the two camps at war (${S(fronts.war && { pairs: fronts.pairs, ...fronts.war })})`);
      check(fronts.army && fronts.army.n > 2 && !fronts.army.badCount && fronts.army.color === fronts.army.want && fronts.army.width > 1 && fronts.army.last === armyId && fronts.army.others.every((w) => w < fronts.army.width) && !/rgba\(0, 0, 0, 0\)/.test(fronts.swatch),
        `the selected army's front is drawn on that border in the army's colour, wider and on top, with its swatch in the army bar (${S({ ...fronts.army, swatch: fronts.swatch })})`);

      const fraIndex = await js(`${G}.player`);
      const named = await js(`(() => { const g = ${G}; const v = ${V}; const c = v.camera; const l = v.labels.find((x) => x.nation === ${fraIndex} && x.main);
        return l ? { text: l.text, ctrl: g.prov.ctrl[v.provinceAt(...c.toScreen(l.x, l.y))], n: v.labels.length } : null; })()`);
      check(named && named.text === 'France' && named.ctrl === fraIndex, `France's name lies over land France controls (${S(named)})`);

      // Zoomed out the stacks of one nation merge into fewer counters with the same total; a click on a merged one selects all its stacks.
      const merged = await js(`(() => { const v = ${V}; const c = v.camera; const b = Conquest.ui.shell.bind; const P = v.map.provinces;
        const fr = P[${S(border.chain[0])}]; c.centerOn(fr.x, fr.y, 0.45); const far = v.counters(); const farSum = far.reduce((n, k) => n + k.count, 0);
        c.centerOn(fr.x, fr.y, 14); const near = v.counters(); const nearSum = near.reduce((n, k) => n + k.count, 0);
        const total = b.groups.reduce((n, g) => n + g.divs.length, 0);
        c.centerOn(fr.x, fr.y, 0.45); v.redraw();
        const r0 = document.querySelector('.cq-map').getBoundingClientRect();
        const pick = far.filter((k) => k.members.length > 1 && b.groups[k.lead].side === 'own').map((k) => { const [x, y] = c.toScreen(P[k.prov].x + 0.5, P[k.prov].y + 0.5); return { k, x: x + k.dx, y: y + k.dy }; })
          .find((p) => p.x > 30 && p.y > 30 && p.x < c.w - 30 && p.y < c.h - 30 && document.elementFromPoint(r0.left + p.x, r0.top + p.y)?.closest('.cq-map') && !v.markerAt(p.x, p.y)
            && b.counterAt(Math.round(p.x), Math.round(p.y))?.merged === p.k.members.length);
        return { groups: b.groups.length, total, far: far.length, farSum, near: near.length, nearSum, pick: pick && { x: r0.left + Math.round(pick.x), y: r0.top + Math.round(pick.y), members: pick.k.members.length,
          lead: pick.k.members.map((j) => b.groups[j]).filter((g) => g.side === 'own').flatMap((g) => g.divs) } }; })()`);
      check(merged.far < merged.near && merged.farSum === merged.total && merged.nearSum === merged.total, `zooming out merges neighbouring stacks into fewer counters and keeps the total of their numbers (${S({ ...merged, pick: !!merged.pick })})`);
      if (merged.pick) {
        await clickAt(ctx, merged.pick);
        const s2 = await js(`({ divs: ${G}.selection.divisions, prov: ${G}.selection.province })`);
        check(S([...s2.divs].sort((a, b) => a - b)) === S([...merged.pick.lead].sort((a, b) => a - b)), `a click on a merged counter selects every stack of the player's it holds (${S({ members: merged.pick.members, got: s2.divs.length, want: merged.pick.lead.length })})`);
        await js(`(${G}.setSelection({ province: 0, divisions: [], army: ${armyId} }), ${V}.setSelected(0), true)`);
      } else check(false, `a merged counter of the player's is on screen to click (${S(merged)})`);

      await frameChecks(ctx, armyId);

      // Pictures for a reviewer, only when asked for (CONQUEST_SHOTS=<folder>).
      if (process.env.CONQUEST_SHOTS) {
        const dir = process.env.CONQUEST_SHOTS;
        for (let i = 0; i < 8 && (await js(`${G}.date().m * 100 + ${G}.date().d < 818`)); i++) await runFor(ctx, 24 * 6);
        const snap = async (file) => { const r = await ctx.cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(dir, file), Buffer.from(r.result.data, 'base64')); console.log(`screenshot: ${path.join(dir, file)}`); };
        const europe = `(() => { const v = ${V}; const P = v.map.provinces; const paris = P.find((p) => p && p.name === 'Seine') || P[${S(border.chain[0])}]; v.camera.centerOn(paris.x + 260, paris.y + 40, Math.max(v.camera.w / 1500, 0.55)); v.redraw(); return true; })()`;
        await mouse(ctx, 'mouseMoved', 5, 5);
        await js(`(${G}.setSelection({ province: 0, divisions: [], army: null }), ${V}.setSelected(0), Conquest.ui.shell.openPanel(null), Conquest.ui.shell.setLegend(false), true)`);
        for (const [kind, text] of [['battle-lost', 'Battle of Longwy: the attackers won'], ['lost', 'German Empire took Ardennes'], ['taken', 'France took Mulhouse']]) await js(`(Conquest.ui.shell.alert(${S(kind)}, ${S(text)}), true)`);
        await js(europe); await sleep(500); await snap('stage2-europe-dark.png');
        await js(`(ide.settings.set('appearance.theme', 'light'), true)`);
        await until(`document.documentElement.dataset.theme === 'light'`, 'the light theme', 5000);
        await js(europe); await sleep(600); await snap('stage2-europe-light.png'); await snap('stage4-europe-light.png');
        await js(`(ide.settings.set('appearance.theme', 'dark'), true)`);
        await until(`document.documentElement.dataset.theme !== 'light'`, 'the dark theme', 5000);
        const cardProv = await js(`(() => { const g = ${G}; for (const d of g.divs.values()) if (d.nation === g.player && !g.map.provinces[d.prov].sea) return d.prov; return 0; })()`);
        await js(`(Conquest.ui.shell.openPanel('production'), ${G}.setSelection({ province: ${cardProv} }), ${V}.setSelected(${cardProv}), ${V}.focus(${cardProv}), true)`);
        await until(`document.querySelector('.cq-card')?.dataset.province === '${cardProv}'`, 'the card beside the panel', 8000);
        await sleep(600); await snap('stage2-panel-dark.png');
        await js(`(Conquest.ui.shell.openPanel(null), ${G}.setSelection({ province: 0 }), ${V}.setSelected(0), true)`);
      }
      await frame(ctx, [...border.chain, border.enemyNext, deep], 0.25);
      await js(`(${G}.setSelection({ province: 0 }), ${V}.setSelected(0), true)`);
      await mouse(ctx, 'mouseMoved', 5, 5);
      await sleep(400);
      const shoot = async (file) => { const r = await ctx.cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(OUT, file), Buffer.from(r.result.data, 'base64')); return path.join(OUT, file); };
      console.log(`screenshot: ${await shoot('conquest-game-dark.png')}`);
      await js(`(ide.settings.set('appearance.theme', 'light'), true)`);
      await until(`document.documentElement.dataset.theme === 'light'`, 'the light theme', 5000);
      await sleep(500);
      console.log(`screenshot: ${await shoot('conquest-game-light.png')}`);
      const lum = await js(`(() => { const l = (c) => { const [r, g, b] = c.match(/\\d+/g).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        return { bar: l(getComputedStyle(document.querySelector('.cq-bar')).backgroundColor), army: l(getComputedStyle(document.querySelector('.cq-army-name')).color), armybar: l(getComputedStyle(document.querySelector('.cq-armybar')).backgroundColor) }; })()`);
      check(lum.bar > 180 && Math.abs(lum.army - lum.armybar) > 100, `the game's chrome reads in the light theme (${S(lum)})`);
      await js(`(ide.settings.set('appearance.theme', 'dark'), true)`);
    } else check(false, `France has a border with Germany to draw on (${S({ border, armyId })})`);

    // Quit to Start saves the game and shows the start screen again.
    await ctx.click('.cq-quit');
    await until(`!!document.querySelector('.dialog-buttons button.primary')`, 'the quit question', 5000);
    await ctx.click('.dialog-buttons button.primary');
    await until(`${G}.status === 'none' && ${shown('.cq-start')}`, 'the start screen again', 30000);
    check(!!newestAutosave(), `Quit to Start writes the game's autosave and goes back to the start screen (${newestAutosave()})`);

    // ---------- a generated map, two nations at war from the start ----------
    await ctx.click('.cq-scenario .cq-seg-btn[data-value="generated"]');
    await until(`${shown('.cq-gen')} && Conquest.app.source === 'generated'`, 'the generated map', 30000);
    const setNumber = async (sel, v) => { await ctx.click(sel); await ctx.press('Ctrl+A'); await ctx.type(String(v)); };
    await setNumber('.cq-gen-provinces', 90);
    await setNumber('.cq-gen-nations', 2);
    await setNumber('.cq-gen-seed', 11);
    await ctx.click('.cq-gen-war');
    await ctx.click('.cq-generate');
    await until(`${V}.map.provinces.filter((p) => p && !p.sea).length >= 80 && ${V}.map.provinces.filter((p) => p && !p.sea).length <= 100`, 'the 90-province map', 30000);
    await ctx.click('.cq-start-game');
    await until(`${G}.running && ${G}.source === 'generated'`, 'the generated game', 60000);
    await sleep(300);
    const gen = await js(`({ nations: ${G}.nations.length, war: ${G}.nations.filter((n) => n.war).length, armies: ${G}.me.armies.length, player: ${G}.player })`);
    check(gen.nations === 2 && gen.war === 1 && gen.armies >= 1, `a generated map with two nations at war from the start runs (${S(gen)})`);
    await js(`(${V}.camera.fit(), ${V}.redraw(), true)`);

    const army = await js(`${G}.me.armies.slice().sort((a, b) => b.divs.length - a.divs.length)[0].id`);
    await ctx.click(`.cq-army[data-army="${army}"]`);
    await sleep(250);
    const hi = await js(`({ active: document.querySelector('.cq-army.active')?.dataset.army, selected: Conquest.ui.shell.bind.groups.filter((g) => g.selected).flatMap((g) => g.divs).sort((a, b) => a - b), army: ${G}.me.armies.find((a) => a.id === ${army}).divs.filter((id) => ${G}.divs.has(id)).sort((a, b) => a - b) })`);
    check(hi.active === String(army) && hi.selected.length > 0 && hi.army.every((id) => hi.selected.includes(id)), `selecting an army in the army bar highlights its card and its divisions' counters (${hi.army.length} divisions, ${hi.selected.length} framed)`);

    const contact = await js(CONTACT());
    let frontIds = [];
    if (contact.chain.length >= 2) {
      await frame(ctx, contact.chain, 0.4);
      await ctx.click('.cq-draw-front');
      // A real drag across the chain from its first province to its last.
      const pts = [];
      for (const id of contact.chain) pts.push(await anchor(ctx, id));
      await mouse(ctx, 'mouseMoved', pts[0].x, pts[0].y);
      await mouse(ctx, 'mousePressed', pts[0].x, pts[0].y, { buttons: 1 });
      for (let i = 1; i < pts.length; i++) for (let k = 1; k <= 6; k++) await mouse(ctx, 'mouseMoved', pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k / 6, pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k / 6, { button: 'left', buttons: 1 });
      await mouse(ctx, 'mouseReleased', pts.at(-1).x, pts.at(-1).y, { buttons: 0 });
      const chain = await js(`Conquest.ui.command.drawing?.chain`);
      await ctx.press('Enter');
      await sleep(400);
      frontIds = await js(`${G}.me.armies.find((a) => a.id === ${army}).front || []`);
      check(chain?.length >= 2 && contact.chain.every((p) => chain.includes(p)) && frontIds.length === chain.length, `a drag across the provinces draws the front chain and Enter sends a front order the worker accepts (${S({ chain, front: frontIds })})`);
      const before = await js(`${G}.me.armies.find((a) => a.id === ${army}).divs.filter((id) => ${S(frontIds)}.includes(${G}.divs.get(id)?.prov)).length`);
      const filled = await runUntil(ctx, `(() => { const ids = ${S(frontIds)}; const g = ${G}; const a = g.me.armies.find((x) => x.id === ${army}); const held = ids.filter((p) => g.prov.ctrl[p] === g.player);
        return held.length && held.every((p) => a.divs.some((id) => g.divs.get(id)?.prov === p)); })()`, 'the front manned', 24 * 12, 4);
      const after = await js(`(() => { const g = ${G}; const a = g.me.armies.find((x) => x.id === ${army}); return { day: Math.floor(g.hour / 24), onFront: a.divs.filter((id) => ${S(frontIds)}.includes(g.divs.get(id)?.prov)).length,
        held: ${S(frontIds)}.filter((p) => g.prov.ctrl[p] === g.player).length }; })()`);
      check(filled, `within 12 game days the general puts a division of the army on every province of the front it holds (${before} -> ${S(after)})`);
    } else check(false, `the player has a contact line to draw a front on (${S(contact)})`);

    // An offensive from the front into enemy land, launched from the list of the army's offensives.
    const tgt = await js(`(() => { const g = ${G}; const P = g.map.provinces; const foe = g.nations.find((n) => n.war).index; const ids = ${S(frontIds)};
      let first = 0; for (const p of ids) { first = P[p].adj.find((q) => !P[q].sea && g.prov.ctrl[q] === foe) || 0; if (first) break; }
      return { first, capital: g.scenario.nations[foe].capital, foe }; })()`);
    if (tgt.first) {
      await frame(ctx, [...frontIds, tgt.first, tgt.capital], 0.45);
      await ctx.click('.cq-draw-offensive');
      await clickAt(ctx, await anchor(ctx, tgt.first));
      await clickAt(ctx, await anchor(ctx, tgt.capital));
      await ctx.press('Enter');
      await sleep(400);
      const off = await js(`${G}.me.armies.find((a) => a.id === ${army}).offensives[0] || null`);
      await until(shown('.cq-offs-btn'), 'the Offensives button', 5000);
      if (!(await js(shown('.cq-offs-pop .cq-off .cq-launch')))) await ctx.click('.cq-offs-btn');
      await until(shown('.cq-offs-pop .cq-off .cq-launch'), 'the launch button in the list', 5000);
      await ctx.click('.cq-offs-pop .cq-off .cq-launch');
      await sleep(300);
      const on = await js(`${G}.me.armies.find((a) => a.id === ${army}).offensives[0]?.on`);
      check(off && off.path[0] === tgt.first && off.path.at(-1) === tgt.capital && on === true, `Draw Offensive and Launch send an offensive along the clicked path and start it (${S({ path: off?.path, on })})`);
      const path0 = off?.path || [];
      const attacked = await runUntil(ctx, `(() => { const g = ${G}; const path = ${S(path0)}; const a = g.me.armies.find((x) => x.id === ${army});
        return g.battles.some((b) => b.side === g.player && path.includes(b.prov)) || path.some((p) => g.prov.ctrl[p] === g.player) || a.divs.some((id) => path.includes(g.divs.get(id)?.to)); })()`, 'the army attacks', 24 * 20);
      const how = await js(`(() => { const g = ${G}; const path = ${S(path0)}; return { day: Math.floor(g.hour / 24), battles: g.battles.filter((b) => path.includes(b.prov)).map((b) => [b.prov, b.side]), taken: path.filter((p) => g.prov.ctrl[p] === g.player) }; })()`);
      check(attacked, `the launched offensive makes the army attack along its path (${S(how)})`);
    } else check(false, 'an enemy province borders the front');

    // Direct control: a division halted, sent by a right click, arrives and stays.
    const pick = await js(`(() => { const g = ${G}; const P = g.map.provinces; const busy = new Set(${S(frontIds)});
      for (const d of [...g.divs.values()].sort((a, b) => a.id - b.id)) { if (d.nation !== g.player || P[d.prov].sea || d.to > 0) continue;
        const ring = P[d.prov].adj.filter((q) => !P[q].sea && g.prov.ctrl[q] === g.player);
        for (const q of ring) for (const r of P[q].adj) if (r !== d.prov && !P[r].sea && g.prov.ctrl[r] === g.player && !P[r].adj.some((x) => !P[x].sea && g.nations[g.prov.ctrl[x]]?.war) && !busy.has(r)) return { div: d.id, from: d.prov, to: r };
      } return null; })()`);
    if (pick) {
      await frame(ctx, [pick.from, pick.to], 0.3);
      await mouse(ctx, 'mouseMoved', 5, 5);
      await js(`(${G}.setSelection({ province: ${pick.from}, divisions: [] }), ${V}.setSelected(${pick.from}), true)`);
      await until(`Conquest.ui.command.revealDivision(${pick.div}) && !!document.querySelector('.cq-div-row[data-div="${pick.div}"]')`, 'the division in the card', 8000);
      await ctx.click(`.cq-div-row[data-div="${pick.div}"]`);
      await until(`${G}.selection.divisions.includes(${pick.div}) && ${shown('.cq-direct')}`, 'the division selected', 5000);
      await ctx.click('.cq-direct');
      await until(`${G}.divs.get(${pick.div})?.manual === true`, 'direct control', 8000);
      const tp = await anchor(ctx, pick.to);
      await mouse(ctx, 'mouseMoved', tp.x, tp.y);
      await sleep(500);
      const tip = await js(`[...document.querySelectorAll('.cq-tip .cq-tip-line')].map((n) => n.textContent).join(' | ')`);
      await clickAt(ctx, { x: tp.x + 4, y: tp.y + 12 }, 'right');
      await until(`${G}.divs.get(${pick.div})?.to > 0 || ${G}.divs.get(${pick.div})?.prov === ${pick.to}`, 'the division moving', 8000);
      check(/hours on the way/.test(tip), `hovering a province with the division selected previews the route and its hours (${tip})`);
      const arrived = await runUntil(ctx, `${G}.divs.get(${pick.div})?.prov === ${pick.to} && ${G}.divs.get(${pick.div})?.to < 0`, 'the division arrives', 24 * 8, 4);
      await runFor(ctx, 24 * 3, 4);
      const d = await js(`(() => { const d = ${G}.divs.get(${pick.div}); return d && { prov: d.prov, to: d.to, manual: d.manual }; })()`);
      check(arrived && d && d.prov === pick.to && d.manual && d.to < 0, `a division under direct control moves where it was sent and the general leaves it there (${S({ pick, d })})`);

      // A refused order: right-click the sea with the division selected.
      const seaPt = await js(`(() => { const v = ${V}; const c = v.camera; const r = document.querySelector('.cq-map').getBoundingClientRect();
        for (let y = 40; y < c.h - 40; y += 17) for (let x = 40; x < c.w - 40; x += 17) { const id = v.provinceAt(x, y); if (id > 0 && v.map.provinces[id].sea && document.elementFromPoint(r.left + x, r.top + y)?.closest('.cq-map')) return { x: r.left + x, y: r.top + y, id }; }
        return null; })()`);
      if (seaPt) {
        await clickAt(ctx, seaPt, 'right');
        await until(shown('.cq-toast'), 'the refusal', 5000);
        const toast = await js(`(() => { const t = document.querySelector('.cq-toast').getBoundingClientRect(); return { text: document.querySelector('.cq-toast').textContent, x: t.x, y: t.y, w: t.width, h: t.height, want: Conquest.ui.text.reason('sea') }; })()`);
        const dist = Math.hypot(toast.x - seaPt.x, toast.y + toast.h / 2 - seaPt.y);
        check(toast.text === toast.want && dist < 120, `a refused order shows its translated reason next to the cursor (${S({ text: toast.text, dist: Math.round(dist) })})`);
      } else check(false, 'a sea zone on screen to send a division to');
    } else check(false, 'a division of the player with room to move');

    await commandChecks(ctx, army);

    // A worker failure is a message with a way back, not a frozen screen.
    if (!(await js(shown('.cq-legend')))) await ctx.click('.cq-legend-toggle');
    const legendOpen = await js(shown('.cq-legend'));
    await js(`(${G}.setSpeed(3), ${G}.debug.fault(), true)`);
    await until(`${shown('.cq-crash')} && ${G}.status === 'crashed'`, 'the crash notice', 15000);
    const crash = await js(`({ msg: document.querySelector('.cq-crash-msg').textContent, title: document.querySelector('.cq-crash-title').textContent })`);
    check(/fault/.test(crash.msg), `a failure in the worker shows "${crash.title}" with its message (${crash.msg.slice(0, 80)})`);
    await ctx.click('.cq-crash-reload');
    await until(`${G}.status === 'running' && !${shown('.cq-crash')}`, 'the game reloaded', 60000);
    check((await js(`${G}.source`)) === 'generated', 'Reload Last Save starts the game again from the autosave');
    const legendAgain = await js(`({ shown: ${shown('.cq-legend')}, pressed: document.querySelector('.cq-legend-toggle').getAttribute('aria-pressed') })`);
    check(legendOpen && legendAgain.shown && legendAgain.pressed === 'true', `the legend opened before the game screen restarted (Reload Last Save) is open again (${S(legendAgain)})`);
    await js(`(Conquest.ui.shell.setLegend(false), true)`);

    // Quitting the window saves the game.
    await runFor(ctx, 24 * 2, 4);
    await js(`(${G}.setSelection({ army: null, divisions: [], province: 0 }), true)`);
    const before = await js(`(async () => ({ hour: ${G}.hour, date: document.querySelector('.cq-date').textContent, hash: await ${G}.query('hash'), plans: JSON.stringify(await ${G}.query('plans')) }))()`);
    const auto = path.join(home, 'Saves', `${await js(`${G}.autosaveName`)}.ncq`);
    const savedAt = existsSync(auto) ? statSync(auto).mtimeMs : 0;
    await js(`(ide.api.invoke('window:close').catch(() => {}), true)`).catch(() => {});
    let exited = false;
    for (let end = Date.now() + 30000; Date.now() < end && !exited; await sleep(250)) { try { process.kill(ctx.pid, 0); } catch { exited = true; } }
    const head = existsSync(auto) ? readFileSync(auto, 'utf8').slice(0, 400) : '';
    check(exited && statSync(auto).mtimeMs > savedAt && /"meta":\{"scenario":"generated"/.test(head) && head.includes(`"hour":${before.hour}`), `closing the window writes the autosave first, then the app quits (${S({ exited, head: head.slice(0, 160) })})`);
    done(ctx, 'game');
    ctx.close();

    // ---------- Continue ----------
    const c2 = await launch({ fixture: 'core', port: 9838, name: 'conquest-game-2', mode: 'conquest', env });
    await c2.until('window.__conquestReady === true', 'the start screen', 90000);
    await c2.until(shown('.cq-continue'), 'the Continue button', 15000);
    const label = await text(c2, '.cq-continue');
    await c2.click('.cq-continue');
    await c2.until(`${G}.running`, 'the continued game', 90000);
    await sleep(300);
    const after = await c2.js(`(async () => ({ hour: ${G}.hour, date: document.querySelector('.cq-date').textContent, hash: await ${G}.query('hash'), plans: JSON.stringify(await ${G}.query('plans')) }))()`);
    check(/Continue/.test(label) && after.hour === before.hour && after.date === before.date && after.hash === before.hash && after.plans === before.plans,
      `Continue restores the same date, state hash and plans (${S({ label, before: { ...before, plans: before.plans.length }, after: { ...after, plans: after.plans.length } })})`);
    done(c2, 'continue');
    c2.close();
  }

  // ---------- Korean ----------
  {
    const ctx = await launch({ fixture: 'core', port: 9839, name: 'conquest-game-ko', mode: 'conquest', lang: 'ko-KR', env: { PYIDE_CONQUEST_HOME: path.join(tempDir('conquest-game-ko'), 'Home') } });
    await ctx.until('window.__conquestReady === true', 'the start screen in Korean', 90000);
    await ctx.js(`(ide.settings.set('conquest.guideDone', true), true)`);
    await ctx.until(`!!document.querySelector('.cq-major[data-tag="FRA"]')`, 'the majors', 15000);
    const ko = await ctx.js(`({ sub: document.querySelector('.cq-start-sub').textContent, start: document.querySelector('.cq-start-game').textContent, fra: document.querySelector('.cq-major[data-tag="FRA"]').textContent,
      tabs: [...document.querySelectorAll('.cq-start-tabs .cq-seg-btn')].map((b) => b.textContent) })`);
    const leaksStart = await englishLeaks(ctx, '.cq-start', ['Conquest']);
    check(ko.sub === '1차 세계 대전의 나라 이끌기' && ko.start === '게임 시작' && ko.fra === '프랑스' && ko.tabs[0] === '새 게임' && !leaksStart.length, `the start screen speaks Korean (${S({ ko, leaksStart })})`);
    await ctx.click('.cq-major[data-tag="FRA"]');
    await ctx.click('.cq-start-game');
    await ctx.until(`${G}.running`, 'the Korean game', 90000);
    await sleep(500);
    const top = await ctx.js(`({ date: document.querySelector('.cq-date').textContent, nation: document.querySelector('.cq-nation').textContent, pause: document.querySelector('.cq-speed-pause .cq-speed-text').textContent,
      reason: Conquest.ui.text.reason('no-path'), unknown: Conquest.ui.text.reason('some-new-reason') })`);
    const leaks = await englishLeaks(ctx, '.cq-bar, .cq-armybar, .cq-legend, .cq-dock', ['Conquest']);
    check(/^1914년 6월 28일/.test(top.date) && top.nation === '프랑스' && top.pause === '계속' && top.reason === '그곳으로 가는 길이 없습니다.' && top.unknown === 'Some new reason' && !leaks.length,
      `the game speaks Korean, and an unknown reason still reads as words (${S({ top, leaks })})`);
    const fat = await ctx.js(`(() => { const r = document.querySelector('.cq-stat[data-stat="fatigue"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await mouse(ctx, 'mouseMoved', fat.x, fat.y);
    await ctx.until(`!!document.querySelector('.cq-stat-tip .cq-tip-row[data-k="collapse"]')`, 'the Korean fatigue tooltip', 8000);
    const tipLeaks = await englishLeaks(ctx, '.cq-stat-tip, .cq-paused-flag, .cq-time', ['Conquest']);
    check(!tipLeaks.length && (await ctx.js(`document.querySelector('.cq-paused-word').textContent`)) === '일시 정지됨', `the paused flag and a resource tooltip speak Korean (${S(tipLeaks)})`);
    if (process.env.CONQUEST_SHOTS) {
      const r = await ctx.cdp('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(process.env.CONQUEST_SHOTS, 'stage2-paused-ko-dark.png'), Buffer.from(r.result.data, 'base64'));
    }
    await mouse(ctx, 'mouseMoved', 5, 300);
    const kcap = await ctx.js(`${G}.scenario.nations[${G}.player].capital`);
    await ctx.js(`(${G}.setSelection({ province: ${kcap} }), true)`);
    await ctx.until(`document.querySelector('.cq-card')?.dataset.province === '${kcap}'`, 'the Korean card', 8000);
    const kq = await ctx.js(`${G}.query('province', { id: ${kcap} })`);
    const kt = await ctx.js(`(() => { const f = [...document.querySelectorAll('.cq-fact')].find((x) => x.children[0].textContent === '참호'); return f ? [f.children[1].textContent, f.dataset.note] : null; })()`);
    check(kt && kt[0] === (kq.dug ? `깊음 (${kq.works})` : `얕음 (${kq.trench} 중 ${kq.works})`) && kt[1].startsWith(`참호가 ${kq.trench}에 이르기 전에는 이곳의 전투에서 이긴 공격 사단이 한 시간 안에 이 칸을 차지합니다.`),
      `the trench fact and its tooltip speak Korean (${S(kt)})`);
    const kp = await ctx.js(`(() => { const t = Conquest.ui.text.tr; const k = '{att} attacks {def}: {odds} an hour for the attackers'; const go = 'Going to {dest}: next {next} in {eta} hours, there in {h} hours.';
      return { a: t(k, { att: '독일 제국', def: '프랑스', odds: '50%' }), b: t(k, { att: '러시아', def: '영국', odds: '50%' }), c: t(k, { att: 'Serbia', def: 'A1', odds: '50%' }),
        d: t(go, { dest: '베를린', next: '-', eta: 1, h: 2 }), e: t(go, { dest: '서울', next: '-', eta: 1, h: 2 }), f: t(go, { dest: '파리', next: '-', eta: 1, h: 2 }) }; })()`);
    check(kp.a.startsWith('독일 제국이 프랑스를 공격합니다') && kp.b.startsWith('러시아가 영국을 공격합니다') && kp.c.startsWith('Serbia이(가) A1을(를) 공격합니다')
      && kp.d.startsWith('베를린으로 갑니다') && kp.e.startsWith('서울로 갑니다') && kp.f.startsWith('파리로 갑니다'),
      `Korean particles follow the name's final consonant (이/가, 을/를, 으로/로 with the ㄹ rule), and a name ending in a Latin letter or digit gets the double form (${S(kp)})`);
    const kpeace = await ctx.js(`(() => { const tur = ${G}.scenario.nations.findIndex((n) => n.tag === 'TUR'); const fra = ${G}.scenario.nations.findIndex((n) => n.tag === 'FRA');
      return [Conquest.ui.text.log({ kind: 'peace', a: tur, b: fra }), Conquest.ui.text.log({ kind: 'peace', a: fra, b: tur })]; })()`);
    check(S(kpeace) === S(['오스만 제국과 프랑스 강화', '프랑스와 오스만 제국 강화']), `the log's peace line takes 과 or 와 by the first nation's name (${S(kpeace)})`);
    // No alert may pause the run to the first battle (runUntil waits on the hour, which stops while paused).
    await ctx.js(`(${G}.setSelection({ province: 0 }), ide.settings.set('conquest.pauseOn', { war: false, offer: false, lost: false, taken: false, 'battle-lost': false, 'low-supply': false, event: false }), true)`);
    const kb = await runUntil(ctx, `${G}.battles.some((b) => b.hours > 0)`, 'a battle in the Korean game', 24 * 70);
    if (kb) {
      const kp = await ctx.js(`${G}.battles.find((b) => b.hours > 0).prov`);
      await ctx.js(`(${V}.camera.centerOn(${V}.map.provinces[${kp}].x, ${V}.map.provinces[${kp}].y, 2.5), ${V}.redraw(), Conquest.ui.battle.open(${kp}), true)`);
      await ctx.until(`!!document.querySelector('.cq-battle:not([hidden]) .cq-factor')`, 'the Korean battle window', 8000).catch(() => {});
      const kw = await ctx.js(`({ title: document.querySelector('.cq-battle-title')?.textContent, rule: document.querySelector('.cq-rule-line')?.textContent, factor: document.querySelector('.cq-factor-label')?.textContent, role: document.querySelector('.cq-bdiv-role')?.textContent })`);
      const kLeaks = await englishLeaks(ctx, '.cq-battle-rules, .cq-factor-list, .cq-balance-cap, .cq-battle-width, .cq-bdiv-role, .cq-meter-label', ['Conquest']);
      check(/전투$/.test(kw.title || '') && /방어선/.test(kw.rule || '') && !!kw.factor && !/[A-Za-z]/.test(kw.factor) && /[가-힣]/.test(kw.role || '') && !kLeaks.length, `the battle window speaks Korean (${S({ kw, kLeaks })})`);
      await snapTo(ctx, 'stage3-battle-ko-dark.png');
      if (process.env.CONQUEST_SHOTS) {
        await ctx.press('Escape');
        await ctx.js(`(() => { const v = ${V}; const P = v.map.provinces; const paris = P.find((p) => p && p.name === 'Seine') || P[${kcap}]; v.camera.centerOn(paris.x + 260, paris.y + 40, Math.max(v.camera.w / 1500, 0.55)); v.redraw(); return true; })()`);
        await sleep(600);
        await snapTo(ctx, 'stage4-europe-ko-dark.png');
      }
    } else check(false, 'a battle is fought in the Korean game');
    done(ctx, 'korean');
    ctx.close();
  }

  // ---------- every tr() literal under ui/ and view/ has its Korean ----------
  {
    const LITERAL = /\btr\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
    const dict = { ...JSON.parse(readFileSync(path.join(APP_DIR, 'renderer', 'locales', 'ko.json'), 'utf8')), ...JSON.parse(readFileSync(path.join(FEATURE, 'locales', 'ko.json'), 'utf8')) };
    const missing = [];
    for (const dir of ['ui', 'view']) {
      for (const f of readdirSync(path.join(FEATURE, dir)).filter((x) => x.endsWith('.js'))) {
        const src = readFileSync(path.join(FEATURE, dir, f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
        for (const m of src.matchAll(LITERAL)) {
          if (m[1] === '`' && m[2].includes('${')) continue;
          const key = m[2].replace(/\\(['"`\\])/g, '$1');
          if (!(key in dict)) missing.push(`${dir}/${f}: ${key}`);
        }
      }
    }
    check(!missing.length, `every tr() literal under ui/ and view/ has Korean (${missing.length} missing${missing.length ? `: ${missing.slice(0, 5).join('; ')}` : ''})`);
    const conquestKo = JSON.parse(readFileSync(path.join(FEATURE, 'locales', 'ko.json'), 'utf8'));
    const doubled = Object.values(conquestKo).filter((v) => /\((가|를|는|과|와|이|을|은)\)|\(으\)로/.test(v));
    check(!doubled.length, `no Conquest string writes a particle in the "(가)" style; they use the markers ui/text.js resolves (${S(doubled.slice(0, 3))})`);
    const NAME_SLOTS = 'nation|province|prov|army|general|division|template|name|names|a|b|to|from|ally|enemy|target|goal|capital|owner|ctrl|us|them|att|def|dest|next|bloc|branch|item|building';
    const bare = new RegExp(`\\{(${NAME_SLOTS})\\}(이|가|을|를|은|는|와|과|으로|로)`);
    const hardWired = Object.values(conquestKo).filter((v) => bare.test(v));
    check(!hardWired.length, `no Conquest string puts a fixed particle right after a name; it writes the marker, {a}{과/와} (${hardWired.length}: ${S(hardWired.slice(0, 3))})`);
  }
} catch (err) {
  check(false, `the suite ran to the end (${err?.stack || err})`);
}

if (errors.length) console.log(`renderer exceptions or CSP violations:\n  ${errors.join('\n  ')}`);
check(!errors.length, 'no renderer exceptions or CSP violations');
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
