// Nano Studio Conquest's economy and army-building screens and the first-session polish (ui/panel-production.js,
// ui/panel-designer.js, ui/eco-*.js, ui/guide.js, ui/settings.js, the staff fronts, the speed rates of sim/host.js, the
// economy, buildable and suggestFronts queries of sim/queries.js, per-game autosaves in main/features/conquest.js),
// driven with real mouse and key events on small generated maps whose state the test sets through the worker's test
// message (PYIDE_CONQUEST_TEST=1): staff fronts off and on, and a hand-drawn front Replan All Fronts leaves alone; the
// speed rates against the clock; a production line raised with + and the output the worker reports on the next day,
// a raise past the free factories refused, a locked item, what the stock equips; a military factory picked on the map,
// queued and shown on the province card once built; two divisions trained, paid for, counted down and formed in a new
// army; the designer's slot picker, stats with signed deltas, the counters check, Save as New and a full grid; a card
// with 85 divisions; the top bar at 1024x720; settings applied live (pause on alerts, autosave off); two games with
// two autosaves and Continue; the first-game guide to a launched offensive, and Don't Show Again; Korean; screenshots
// verify/out/conquest-production-dark.png, conquest-designer-dark.png and conquest-designer-light.png. Ports 9971-9972.
import { existsSync, readdirSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, tempDir } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(APP_DIR, 'verify', 'out');
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
const home = path.join(tempDir('conquest-panels'), 'Conquest Home');
const env = { PYIDE_CONQUEST_HOME: home, PYIDE_CONQUEST_TEST: '1' };
const GEN = { provinces: 90, nations: 2, seed: 11, war: true };

const mouse = (ctx, type, x, y, extra = {}) => ctx.cdp('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1, ...extra });
async function clickAt(ctx, p) {
  await mouse(ctx, 'mouseMoved', p.x, p.y);
  await sleep(30);
  await mouse(ctx, 'mousePressed', p.x, p.y, { buttons: 1 });
  await mouse(ctx, 'mouseReleased', p.x, p.y, { buttons: 0 });
  await sleep(150);
}
const pagePoint = (ctx, mx, my) => ctx.js(`(() => { const r = document.querySelector('.cq-map').getBoundingClientRect(); const [x, y] = ${V}.camera.toScreen(${mx}, ${my});
  const at = document.elementFromPoint(r.left + x, r.top + y); return { x: r.left + x, y: r.top + y, onMap: !!at?.closest('.cq-map') }; })()`);
const anchor = async (ctx, id) => { const p = await ctx.js(`(({ x, y }) => ({ x, y }))(${V}.map.provinces[${id}])`); return pagePoint(ctx, p.x + 0.5, p.y + 0.5); };
const frame = (ctx, ids, fill = 0.35) => ctx.js(`(() => { const v = ${V}; const P = v.map.provinces; const ps = ${S(ids)}.map((i) => P[i]);
  const xs = ps.map((p) => p.x); const ys = ps.map((p) => p.y); const w = Math.max(...xs) - Math.min(...xs) + 4; const h = Math.max(...ys) - Math.min(...ys) + 4;
  const c = v.camera; c.centerOn((Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2, Math.min(c.w * ${fill} / w, c.h * ${fill} / h, 16)); v.redraw(); return true; })()`);
// A clear spot of the map, for a click that gives the map the keyboard.
const mapSpot = async (ctx) => ctx.js(`(() => { const r = document.querySelector('.cq-map').getBoundingClientRect();
  for (let y = r.top + 60; y < r.bottom - 60; y += 23) for (let x = r.left + 330; x < r.right - 60; x += 23) { const n = document.elementFromPoint(x, y); if (n?.closest('.cq-map')) return { x, y }; } return null; })()`);
const runFor = async (ctx, hours, speed = 4) => {
  const target = (await ctx.js(`${G}.hour`)) + hours;
  await ctx.js(`${G}.setSpeed(${speed}), true`);
  try { await ctx.until(`${G}.hour >= ${target} || ${G}.speed === 0`, `${hours} game hours`, 120000); } finally { await ctx.js(`${G}.setSpeed(0), true`); }
  await sleep(300);
};
// The next day boundary and one hour into it, so the daily industry has run.
const nextDay = async (ctx) => { const h = await ctx.js(`${G}.hour`); await runFor(ctx, 24 - (h % 24) + 1); };
const shown = (sel) => `(() => { const n = document.querySelector(${S(sel)}); return !!n && !n.hidden && getComputedStyle(n).display !== 'none' && n.getClientRects().length > 0; })()`;
const setState = (ctx, set) => ctx.js(`${G}.debug.setState(${S(set)})`);
const newGame = async (ctx, extra = {}) => {
  const r = await ctx.js(`${G}.newGame(${S({ scenario: 'generated', gen: GEN, player: 0, seed: 5, ...extra })})`);
  await ctx.until(`${G}.running`, 'the game', 60000);
  await sleep(500);
  return r;
};
const openPanel = async (ctx, id) => {
  if (!(await ctx.js(`Conquest.ui.shell.panelOpen === ${S(id)}`))) await ctx.click(`.cq-dock-tab[data-panel="${id}"]`);
  await ctx.until(`Conquest.ui.shell.panelOpen === ${S(id)}`, `the ${id} panel`, 5000);
  await sleep(600);
};
// Panels scroll: the control is brought into view before the real click.
const clickIn = async (ctx, sel) => { await ctx.js(`document.querySelector(${S(sel)})?.scrollIntoView({ block: 'center' }), true`); await sleep(120); await ctx.click(sel); };
const shoot = async (ctx, file) => { const r = await ctx.cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(OUT, file), Buffer.from(r.result.data, 'base64')); console.log(`screenshot: ${path.join(OUT, file)}`); };
const autosaves = () => { const dir = path.join(home, 'Saves'); return existsSync(dir) ? readdirSync(dir).filter((n) => /^Autosave( .+)?\.ncq$/.test(n)).sort((a, b) => statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs) : []; };
// Contact provinces of the player's, near its capital, in a chain of neighbours, and an enemy province next to them.
const CONTACT = `(() => { const g = ${G}; const P = g.map.provinces; const me = g.player; const foe = (c) => c >= 0 && g.nations[c]?.war;
  const cap = P[g.scenario.nations[me].capital]; const far = (p) => (P[p].x - cap.x) ** 2 + (P[p].y - cap.y) ** 2;
  const contact = []; for (let p = 1; p < P.length; p++) if (!P[p].sea && g.prov.ctrl[p] === me && P[p].adj.some((q) => !P[q].sea && foe(g.prov.ctrl[q]))) contact.push(p);
  contact.sort((a, b) => far(a) - far(b)); const set = new Set(contact); let best = [];
  for (const s of contact) { const chain = [s]; let cur = s; for (let i = 0; i < 3; i++) { const n = P[cur].adj.find((q) => set.has(q) && !chain.includes(q)); if (!n) break; chain.push(n); cur = n; } if (chain.length > best.length) best = chain; if (best.length >= 3) break; }
  const enemy = best.length ? P[best[0]].adj.find((q) => !P[q].sea && foe(g.prov.ctrl[q])) : 0;
  const deep = enemy ? P[enemy].adj.find((q) => !P[q].sea && foe(g.prov.ctrl[q]) && !best.some((b) => P[b].adj.includes(q))) || 0 : 0;
  return { chain: best, enemy, deep }; })()`;

try {
  const ctx = await launch({ fixture: 'core', port: 9971, name: 'conquest-panels', mode: 'conquest', env });
  const { js, until } = ctx;
  await until('window.__conquestReady === true', 'the start screen', 90000);
  await js(`(ide.settings.set('conquest.guideDone', true), ide.settings.set('conquest.staffFronts', false), ide.settings.set('conquest.panel', null), true)`);

  // ---------- staff fronts ----------
  await newGame(ctx);
  const spot = await mapSpot(ctx);
  await clickAt(ctx, spot);
  await ctx.press('Space');
  await until(`${G}.hour >= 26`, 'a game day with the staff off', 60000);
  await ctx.press('Space');
  const off = await js(`({ fronts: ${G}.me.armies.map((a) => a.front), alerts: Conquest.ui.shell.alertCounts().staff || 0, speed: ${G}.speed })`);
  check(off.fronts.every((f) => f === null) && off.alerts === 0, `with the staff setting off, pressing play assigns no front (${S(off)})`);
  await js(`(ide.settings.set('conquest.staffFronts', true), true)`);
  const h0 = await js(`${G}.hour`);
  await ctx.press('Space');
  await until(`${G}.me.armies.every((a) => a.front && a.front.length) || ${G}.hour >= ${h0 + 24}`, 'the staff fronts', 60000);
  await ctx.press('Space');
  const on = await js(`({ hours: ${G}.hour - ${h0}, armies: ${G}.me.armies.map((a) => ({ id: a.id, front: a.front })), alert: (Conquest.ui.shell.openAlerts('staff'), document.querySelector('.cq-alert-entry[data-kind="staff"] .cq-alert-text')?.textContent),
    plan: [...document.querySelectorAll('.cq-army-plan')].map((n) => n.textContent) })`);
  check(on.armies.every((a) => a.front?.length) && on.hours <= 24 && /The staff assigned/.test(on.alert || ''), `with it on, pressing play gives every army a front within a game day, with the alert (${S({ hours: on.hours, alert: on.alert, plan: on.plan })})`);
  const sug = await js(`${G}.query('suggestFronts')`);
  // A section can join a part of the line no army holds (the operations AI's rule), so a front may have several
  // connected pieces: each runs as a chain, one break between pieces at most.
  const chained = await js(`(() => { const P = ${G}.map.provinces; const f = ${S(sug.find((s) => s.kind === 'front')?.provinces || [])}; let adj = 0; for (let i = 1; i < f.length; i++) if (P[f[i - 1]].adj.includes(f[i])) adj++;
    const set = new Set(f); const seen = new Set(); let parts = 0; for (const s of f) { if (seen.has(s)) continue; parts++; const q = [s]; seen.add(s); while (q.length) { const p = q.pop(); for (const r of P[p].adj) if (set.has(r) && !seen.has(r)) { seen.add(r); q.push(r); } } }
    return { n: f.length, adj, parts }; })()`);
  check(chained.n > 1 && chained.adj >= chained.n - chained.parts - 1, `a staff front runs as a chain of neighbouring provinces within each connected piece (${S(chained)})`);

  // A front drawn by hand stays; a new army gets the reserve.
  const army = await js(`${G}.me.armies.slice().sort((a, b) => b.divs.length - a.divs.length)[0].id`);
  const border = await js(CONTACT);
  await ctx.click(`.cq-army[data-army="${army}"]`);
  await frame(ctx, border.chain, 0.4);
  await ctx.click('.cq-draw-front');
  for (const id of border.chain) await clickAt(ctx, await anchor(ctx, id));
  await ctx.press('Enter');
  await sleep(400);
  const hand = await js(`${G}.me.armies.find((a) => a.id === ${army}).front`);
  const extra = await js(`${G}.order({ type: 'army', name: 'Second Army', general: null })`);
  await ctx.click('.cq-replan');
  await until(`!!${G}.me.armies.find((a) => a.id === ${extra.id})?.front`, 'the replanned fronts', 10000).catch(() => {});
  const after = await js(`({ hand: ${G}.me.armies.find((a) => a.id === ${army}).front, extra: ${G}.me.armies.find((a) => a.id === ${extra.id})?.front, cap: ${G}.scenario.nations[${G}.player].capital,
    isHand: Conquest.ui.staff.isHand(${army}), reserve: Conquest.ui.staff.isReserve(${extra.id}) })`);
  check(S(hand) === S(border.chain) && S(after.hand) === S(hand) && after.isHand && after.extra?.includes(after.cap) && after.reserve,
    `a front drawn by hand is not overridden by Replan All Fronts, and an army with no enemy in reach goes to the reserve at the capital (${S({ hand, after })})`);

  // ---------- time ----------
  await clickAt(ctx, await mapSpot(ctx));
  const timed = async (key, ms) => {
    await ctx.press(key);
    await sleep(300);
    const a = await js(`({ h: ${G}.hour, t: performance.now() })`);
    await sleep(ms);
    const b = await js(`({ h: ${G}.hour, t: performance.now() })`);
    await ctx.press('Space');
    const c = await js(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(${G}.hour))))`);
    await sleep(1000);
    const d = await js(`${G}.hour`);
    return { hours: b.h - a.h, secs: (b.t - a.t) / 1000, paused: c === d, c, d };
  };
  const s3 = await timed('3', 20000);
  check(Math.abs(s3.hours - 24 * s3.secs) <= 48, `speed 3 runs a game day a second: ${s3.hours} game hours in ${s3.secs.toFixed(1)} s (${(s3.hours / 24).toFixed(1)} days)`);
  const s1 = await timed('1', 20000);
  check(Math.abs(s1.hours - 2 * s1.secs) <= 4, `speed 1 runs two game hours a second: ${s1.hours} game hours in ${s1.secs.toFixed(1)} s`);
  check(s3.paused && s1.paused, `Space stops the clock within a frame (${S([s3.c, s3.d, s1.c, s1.d])})`);
  const title = await js(`document.querySelector('.cq-speed-n[data-speed="3"]').title`);
  check(/1 game day a second/.test(title), `the speed buttons say their rate (${title})`);

  // ---------- production ----------
  // A game at peace: in the war above the enemy can hold our factory provinces by now, and then every raise is refused.
  await newGame(ctx, { gen: { ...GEN, war: false } });
  await openPanel(ctx, 'production');
  let eco = await js(`${G}.query('economy')`);
  if (eco.free < 2) {
    await setState(ctx, [{ path: ['nations', 0, 'lines', 0, 'factories'], value: Math.max(0, eco.lines[0].factories - (2 - eco.free)) }]);
    await js(`(Conquest.ui.shell.openPanel(null), Conquest.ui.shell.openPanel('production'), true)`);
    await sleep(500);
    eco = await js(`${G}.query('economy')`);
  }
  const line = eco.lines.find((l) => l.item === 'rifles');
  const shownBefore = await js(`document.querySelector('.cq-line[data-item="rifles"] .cq-line-out').textContent`);
  await clickIn(ctx, '.cq-line[data-item="rifles"] .cq-step-plus');
  await until(`${G}.me.lines.find((l) => l.item === 'rifles').factories === ${line.factories + 1}`, 'the line order', 8000);
  await until(`document.querySelector('.cq-line[data-item="rifles"]').dataset.factories === '${line.factories + 1}'`, 'the line redrawn', 8000);
  await nextDay(ctx);
  await sleep(600);
  const eco2 = await js(`${G}.query('economy')`);
  const l2 = eco2.lines.find((l) => l.item === 'rifles');
  const shownAfter = await js(`document.querySelector('.cq-line[data-item="rifles"] .cq-line-out').textContent`);
  const tenths = (n) => (n % 10 === 0 ? String(n / 10) : (n / 10).toFixed(1));
  check(l2.factories === line.factories + 1 && shownAfter === tenths(l2.perDay) && l2.perDay > line.perDay && Number(shownAfter) > Number(shownBefore),
    `+ on the rifle line sends a line order and the output shown the next day is the worker's (${S({ before: shownBefore, after: shownAfter, worker: l2.perDay, factories: l2.factories })})`);
  await clickIn(ctx, '.cq-line[data-item="rifles"] .cq-step-value');
  await ctx.press('Ctrl+A');
  await ctx.type(String(l2.factories + eco2.free + 5));
  await ctx.press('Enter');
  await until(shown('.cq-line[data-item="rifles"] .cq-line-msg'), 'the refusal', 8000).catch(() => {});
  const refused = await js(`({ msg: document.querySelector('.cq-line[data-item="rifles"] .cq-line-msg').textContent, want: Conquest.ui.text.reason('not-enough-factories'), f: ${G}.me.lines.find((l) => l.item === 'rifles').factories })`);
  check(refused.msg === refused.want && refused.f === l2.factories, `raising a line past the free factories shows the refusal (${S(refused)})`);
  const lockedRow = await js(`(() => { const r = document.querySelector('.cq-locked-item[data-item="tanks"]'); return r && { cond: r.querySelector('.cq-locked-cond').textContent, disabled: r.querySelector('button').disabled,
    offered: [...document.querySelectorAll('.cq-new-item option')].map((o) => o.value) }; })()`);
  const lockedLegal = await js(`${G}.query('legal', { order: { type: 'line', item: 'tanks', factories: 1 } })`);
  check(lockedRow && /1916/.test(lockedRow.cond) && /30/.test(lockedRow.cond) && lockedRow.disabled && !lockedRow.offered.includes('tanks') && lockedLegal.reason === 'locked-item',
    `a locked item cannot be started and shows its condition (${S({ lockedRow, lockedLegal })})`);
  const equip = await js(`(async () => { const g = ${G}; const out = [];
    for (const t of g.me.templates) { const s = await g.query('stats', { template: t }); let n = Math.trunc(g.me.manpower / s.manpower);
      g.rules.items.forEach((it, k) => { const need = s.equip[k] | 0; if (need) n = Math.min(n, Math.trunc((g.me.stock[it.id] | 0) / need)); });
      out.push({ id: t.id, want: n, shown: document.querySelector('.cq-equip[data-tpl="' + t.id + '"] .cq-can-equip')?.textContent }); }
    return out; })()`);
  check(equip.length && equip.every((e) => String(e.want) === e.shown), `"divisions the stock equips" matches the worker's stock, manpower and template costs (${S(equip)})`);
  await js(`(ide.settings.set('appearance.theme', 'dark'), true)`);
  await sleep(300);
  await shoot(ctx, 'conquest-production-dark.png');

  // ---------- construction ----------
  await clickIn(ctx, '.cq-build-pick[data-what="mil"]');
  await until('!!Conquest.ui.pick.active', 'the pick mode', 5000);
  const target = await js(`(() => { const g = ${G}; const P = g.map.provinces; const cap = P[g.scenario.nations[g.player].capital]; const legal = Conquest.ui.pick.active.legal;
    return legal.slice().sort((a, b) => ((P[a].x - cap.x) ** 2 + (P[a].y - cap.y) ** 2) - ((P[b].x - cap.x) ** 2 + (P[b].y - cap.y) ** 2))[0]; })()`);
  const banner = await js(`document.querySelector('.cq-pick-text')?.textContent`);
  await frame(ctx, [target], 0.2);
  const before = await js(`${G}.query('province', { id: ${target} })`);
  await clickAt(ctx, await anchor(ctx, target));
  await until(`${G}.me.builds.length === 1`, 'the build order', 8000).catch(() => {});
  await sleep(500);
  const queued = await js(`({ builds: ${G}.me.builds, row: document.querySelector('.cq-build')?.dataset.province, pick: !!Conquest.ui.pick.active })`);
  check(queued.builds.length === 1 && queued.builds[0].prov === target && queued.row === String(target) && !queued.pick, `picking a province on the map sends build and the queue shows it (${S({ banner, target, queued })})`);
  await setState(ctx, [{ path: ['nations', 0, 'builds', 0, 'prog'], value: (await js(`${G}.rules.build.cost.mil`)) - 1 }]);
  await nextDay(ctx);
  await js(`(${G}.setSelection({ province: ${target} }), ${V}.setSelected(${target}), true)`);
  await until(`document.querySelector('.cq-card')?.dataset.province === '${target}'`, 'the card', 8000);
  await sleep(400);
  const fac = await js(`[...document.querySelectorAll('.cq-fact')].map((f) => [f.children[0].textContent, f.children[1].textContent]).find((f) => f[0] === 'Factories')?.[1]`);
  check(fac === `${before.mil + 1} military, ${before.civ} civil` && (await js(`${G}.me.builds.length`)) === 0, `when it completes the province card shows the new factory (${before.mil} -> ${fac})`);
  await js(`(${G}.setSelection({ province: 0 }), true)`);

  // ---------- training ----------
  await clickIn(ctx, '.cq-production .cq-train .cq-step-plus');
  await sleep(400);
  const cost = await js(`({ count: document.querySelector('.cq-production .cq-train-count .cq-step-value').value, at: Number(document.querySelector('.cq-production .cq-train-where').dataset.province),
    rows: Object.fromEntries([...document.querySelectorAll('.cq-production .cq-cost-row')].map((r) => [r.dataset.cost, Number(r.dataset.need)])), man: ${G}.me.manpower, stock: { ...${G}.me.stock }, divs: ${G}.divs.size,
    army: document.querySelector('.cq-production .cq-train-army').value })`);
  await clickIn(ctx, '.cq-production .cq-train-go');
  await until(`${G}.me.training.length === 1`, 'the training order', 8000);
  const paid = await js(`({ man: ${G}.me.manpower, stock: { ...${G}.me.stock }, batch: ${G}.me.training[0] })`);
  const paidRight = cost.man - paid.man === cost.rows.manpower && Object.entries(cost.rows).filter(([k]) => k !== 'manpower').every(([k, v]) => cost.stock[k] - paid.stock[k] === v);
  check(cost.count === '2' && paidRight && paid.batch.count === 2, `ordering 2 divisions lowers manpower and stock by the cost shown (${S({ cost: cost.rows, man: [cost.man, paid.man] })})`);
  // With a short row Start Training is off and says why, instead of sending an order the worker refuses.
  const rifles = paid.stock.rifles;
  await setState(ctx, [{ path: ['nations', 0, 'stock', 'rifles'], value: 0 }]);
  await clickIn(ctx, '.cq-production .cq-train .cq-step-minus');
  await clickIn(ctx, '.cq-production .cq-train .cq-step-plus');
  await sleep(400);
  const shortBtn = await js(`(() => { const b = document.querySelector('.cq-production .cq-train-go'); return { disabled: b.disabled, title: b.title, want: Conquest.ui.text.reason('no-equipment'), short: !!document.querySelector('.cq-production .cq-cost-row.short') }; })()`);
  await setState(ctx, [{ path: ['nations', 0, 'stock', 'rifles'], value: rifles }]);
  check(shortBtn.short && shortBtn.disabled && shortBtn.title === shortBtn.want, `with the stock short Start Training is off and its tooltip says why (${S(shortBtn)})`);
  await until(`!!document.querySelector('.cq-batch')`, 'the queue', 5000);
  const d0 = Number(await js(`document.querySelector('.cq-batch').dataset.days`));
  await nextDay(ctx);
  await sleep(400);
  const d1 = Number(await js(`document.querySelector('.cq-batch')?.dataset.days`));
  const left = await js(`${G}.query('economy').then((e) => Math.ceil(e.training[0].hours / 24))`);
  check(d0 >= 30 && d1 === d0 - 1 && d1 === left, `the training queue counts down with the worker (${d0} -> ${d1}, worker ${left})`);
  await setState(ctx, [{ path: ['nations', 0, 'training', 0, 'done'], value: Math.floor((await js(`${G}.hour`)) / 24) * 24 + 24 }]);
  await nextDay(ctx);
  await until(`${G}.me.armies.some((a) => /^Reserve Army/.test(a.name) && a.divs.length === 2)`, 'the new divisions in their army', 15000).catch(() => {});
  const formed = await js(`(() => { const g = ${G}; const a = g.me.armies.find((x) => /^Reserve Army/.test(x.name)); const ids = a ? a.divs : [];
    const groups = Conquest.ui.shell.bind.groups.filter((gr) => gr.side === 'own' && gr.prov === ${cost.at}).flatMap((gr) => gr.divs);
    return { army: a?.name, ids, at: ids.map((id) => g.divs.get(id)?.prov), counters: ids.every((id) => groups.includes(id)), queue: document.querySelectorAll('.cq-batch').length }; })()`);
  check(formed.ids.length === 2 && formed.at.every((p) => p === cost.at) && formed.counters && formed.queue === 0, `the 2 divisions form as counters in the chosen province and join a new reserve army (${S(formed)})`);

  // ---------- designer ----------
  await openPanel(ctx, 'designer');
  const draftOf = `(() => ({ id: document.querySelector('.cq-tpl.active').dataset.tpl, name: document.querySelector('.cq-tpl-name').value,
    line: [...document.querySelectorAll('.cq-slot-line')].map((n) => n.dataset.branch).filter(Boolean), support: [...document.querySelectorAll('.cq-slot-support')].map((n) => n.dataset.branch).filter(Boolean) }))()`;
  const checksNow = `[...document.querySelectorAll('.cq-check')].map((n) => n.dataset.check)`;
  const first = await js(draftOf);
  const c0 = await js(checksNow);
  const slot = await js(`document.querySelector('.cq-slot-line.empty').dataset.slot`);
  await clickIn(ctx, `.cq-slot-line[data-slot="${slot}"]`);
  await until(shown('.cq-picker'), 'the branch picker', 5000);
  const offered = await js(`[...document.querySelectorAll('.cq-picker .cq-pick-branch')].map((b) => b.dataset.branch + (b.disabled ? '!' : ''))`);
  await clickIn(ctx, '.cq-picker .cq-pick-branch[data-branch="heavy"]');
  await until(`document.querySelector('.cq-slot-line[data-slot="${slot}"]').dataset.branch === 'heavy' && ${checksNow}.includes('heavy')`, 'the stats', 8000).catch(() => {});
  await sleep(500);
  const draft = await js(draftOf);
  const saved = await js(`${G}.me.templates.find((t) => t.id === ${S(first.id)})`);
  const want = await js(`Promise.all([${G}.query('stats', { template: ${S(draft)} }), ${G}.query('stats', { template: ${S(saved)} })])`);
  const rows = await js(`[...document.querySelectorAll('.cq-stat-row')].map((r) => ({ k: r.dataset.stat, v: Number(r.dataset.value), d: Number(r.dataset.delta), text: r.querySelector('.cq-stat-delta').textContent }))`);
  const statsRight = rows.every((r) => r.v === want[0][r.k] && r.d === want[0][r.k] - want[1][r.k] && (r.d > 0 ? r.text.startsWith('+') : r.d < 0 ? r.text.startsWith('−') : r.text === ''));
  check(statsRight && rows.some((r) => r.d !== 0), `a slot changed with the picker updates the stats to the stats query, with signed deltas (${S(rows.filter((r) => r.d))})`);
  const c1 = await js(checksNow);
  check(!offered.includes('air') && offered.includes('tank!') && c0.includes('no-heavy') && !c1.includes('no-heavy') && c1.includes('heavy'),
    `the picker offers only usable branches, and the counters check drops "no heavy guns" once heavy artillery is added (${S({ offered, c0, c1 })})`);
  const nTpl = await js(`${G}.me.templates.length`);
  await clickIn(ctx, '.cq-save-new');
  await until(`${G}.me.templates.length === ${nTpl + 1}`, 'the new template', 8000).catch(() => {});
  const newTpl = await js(`${G}.me.templates[${nTpl}]`);
  const cap = await js(`${G}.scenario.nations[${G}.player].capital`);
  const trainNew = newTpl && await js(`${G}.query('legal', { order: { type: 'train', template: ${S(newTpl.id)}, count: 1, at: ${cap} } })`);
  check(newTpl && newTpl.line.includes('heavy') && trainNew?.ok, `Save as New creates a template a train order accepts (${S({ newTpl, trainNew })})`);
  await shoot(ctx, 'conquest-designer-dark.png');
  for (let i = 0; i < 40 && await js(`!!document.querySelector('.cq-slot-line.empty')`); i++) await clickIn(ctx, '.cq-add-slot');
  await clickIn(ctx, '.cq-add-slot');
  await sleep(300);
  const full = await js(`({ empty: document.querySelectorAll('.cq-slot-line.empty').length, filled: document.querySelectorAll('.cq-slot-line:not(.empty)').length, msg: document.querySelector('.cq-slot-msg').textContent, want: Conquest.ui.text.reason('too-large'), max: ${G}.rules.template.maxLine })`);
  const tooBig = await js(`${G}.query('legal', { order: { type: 'template', template: { id: 'x', name: 'x', line: Array(${G}.rules.template.maxLine + 1).fill('inf'), support: [] } } })`);
  check(full.empty === 0 && full.filled === full.max && full.msg === full.want && tooBig.reason === 'too-large', `a full grid refuses the extra slot (${S({ full, tooBig })})`);
  await js(`(ide.settings.set('appearance.theme', 'light'), true)`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'the light theme', 5000);
  await sleep(500);
  await shoot(ctx, 'conquest-designer-light.png');
  const lum = await js(`(() => { const l = (c) => { const [r, g, b] = c.match(/\\d+/g).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const bg = l(getComputedStyle(document.querySelector('.cq-dock')).backgroundColor); return { bg, text: l(getComputedStyle(document.querySelector('.cq-stat-now')).color), check: l(getComputedStyle(document.querySelector('.cq-check')).color) }; })()`);
  check(Math.abs(lum.bg - lum.text) > 100 && Math.abs(lum.bg - lum.check) > 100, `the designer reads in the light theme (${S(lum)})`);
  await js(`(ide.settings.set('appearance.theme', 'dark'), true)`);

  // ---------- the province card with 85 divisions ----------
  const crowd = await js(`(() => { const g = ${G}; const P = g.map.provinces; const cap = g.scenario.nations[g.player].capital; let max = 0; for (const id of g.divs.keys()) max = Math.max(max, id); return { cap, max, n: g.divs.size }; })()`);
  const set = [];
  const len = crowd.n;
  for (let i = 0; i < 85; i++) set.push({ path: ['divs', len + i], value: { id: crowd.max + 1 + i, nation: 0, tpl: 'inf14', army: null, prov: crowd.cap, str: 1000, org: 1000, dig: 0, to: null, eta: 0, path: [], manual: false, sup: 1000 } });
  set.push({ path: ['next', 'div'], value: crowd.max + 100 });
  await setState(ctx, set);
  await js(`(${G}.setSelection({ province: ${crowd.cap} }), ${V}.setSelected(${crowd.cap}), true)`);
  await until(`document.querySelector('.cq-card')?.dataset.province === '${crowd.cap}' && Number(document.querySelector('.cq-card').dataset.divisions) >= 85`, 'the crowded card', 8000);
  await sleep(300);
  await js(`(Conquest.ui.shell.setLegend(true), true)`);
  const cardRows = await js(`(() => { const box = document.querySelector('.cq-card-divs'); const first = document.querySelectorAll('.cq-card-divs > .cq-card-rows > *').length;
    box.scrollTop = box.scrollHeight; box.dispatchEvent(new Event('scroll'));
    const last = [...document.querySelectorAll('.cq-div-row')].map((r) => Number(r.dataset.div));
    const card = document.querySelector('.cq-card').getBoundingClientRect(); const legend = document.querySelector('.cq-legend').getBoundingClientRect();
    return { first, divisions: Number(document.querySelector('.cq-card').dataset.divisions), lastShown: Math.max(...last), clear: legend.height > 0 && (card.bottom <= legend.top || card.right <= legend.left || card.left >= legend.right || card.top >= legend.bottom) }; })()`);
  await js(`(Conquest.ui.shell.setLegend(false), true)`);
  check(cardRows.divisions >= 85 && cardRows.first <= 30 && cardRows.lastShown === crowd.max + 85 && cardRows.clear, `the province card with 85 divisions keeps a bounded row count, scrolls to the last one and stays clear of the legend (${S(cardRows)})`);
  await js(`(${G}.setSelection({ province: 0 }), true)`);

  // ---------- the top bar at 1024 ----------
  await ctx.cdp('Emulation.setDeviceMetricsOverride', { width: 1024, height: 720, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  const bar = await js(`(() => { const out = []; for (const n of [...document.querySelectorAll('.cq-stat .cq-stat-value'), document.querySelector('.cq-date'), document.querySelector('.cq-speed-pause'), document.querySelector('.cq-quit'), document.querySelector('.cq-save')]) {
    const r = n.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    out.push({ k: n.parentElement.dataset.stat || n.className, text: n.textContent, ok: r.width > 0 && r.right <= innerWidth && !!at && (at === n || n.contains(at)), w: Math.round(r.width) }); } return { out, width: innerWidth }; })()`);
  check(bar.width === 1024 && bar.out.every((b) => b.ok && b.text.trim()), `at 1024x720 every top-bar value is visible (${S(bar.out.filter((b) => !b.ok))})`);
  // The alert badges with a panel open: every kind at once, no name cut; with no room, each kind's mark and count.
  await openPanel(ctx, 'diplomacy');
  await js(`(() => { const s = Conquest.ui.shell; for (const k of Conquest.ui.text.ALERT_KINDS) s.alert(k, 'Badge test ' + k, 0, null, { quiet: true }); return true; })()`);
  await sleep(400);
  const badgeRead = `(() => { const row = document.querySelector('.cq-alert-badges'); return { compact: row.classList.contains('compact'), mapW: Math.round(document.querySelector('.cq-map').getBoundingClientRect().width),
    badges: [...document.querySelectorAll('.cq-alert-badge')].map((b) => { const r = b.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const l = b.querySelector('.cq-alert-badge-label'); const g = b.querySelector('.cq-glyph'); const name = Conquest.ui.text.alert(b.dataset.kind);
      const label = l.getClientRects().length > 0; const mark = !!g && g.getClientRects().length > 0;
      return { k: b.dataset.kind, hit: !!at && b.contains(at), whole: label && l.scrollWidth <= l.clientWidth + 1 && l.textContent === name, mark, aria: (b.getAttribute('aria-label') || '').startsWith(name), tip: b.title.startsWith(name), count: b.querySelector('.cq-alert-count').textContent }; }) }; })()`;
  const narrow = await js(badgeRead);
  const readable = (x) => x.badges.length === 8 && x.badges.every((b) => b.hit && b.aria && b.tip && Number(b.count) >= 1 && (b.whole || (x.compact && b.mark && !b.whole)));
  check(readable(narrow) && narrow.compact, `at 1024x720 with a panel open every alert badge is whole: its kind's mark, the count, and the full name in its tooltip and accessible name, never a cut name (${S(narrow)})`);
  await shoot(ctx, 'conquest-badges-1024-panel.png');
  await ctx.cdp('Emulation.clearDeviceMetricsOverride', {});
  await sleep(500);
  await js(`(document.querySelector('.cq-dock-close, .cq-dock-tab.active')?.click(), true)`);
  await sleep(400);
  const wide = await js(badgeRead);
  check(readable(wide) && (wide.compact || wide.badges.every((b) => b.whole)), `on a wider map the badges show their whole names again when they fit (${S({ compact: wide.compact, mapW: wide.mapW, cut: wide.badges.filter((b) => !b.whole).map((b) => b.k) })})`);
  await js(`(() => { const s = Conquest.ui.shell; s.openAlerts(null); return true; })()`);

  // The command row stays one line at 1024 with six offensives: they sit behind one button whose list launches,
  // stops and removes them, and Remove Finished clears a stopped one.
  await ctx.cdp('Emulation.setDeviceMetricsOverride', { width: 1024, height: 720, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  const oArmy = await js(`${G}.me.armies.slice().sort((a, b) => b.divs.length - a.divs.length)[0].id`);
  await ctx.click(`.cq-army[data-army="${oArmy}"]`);
  const foeLand = await js(`(() => { const g = ${G}; const P = g.map.provinces; return P.map((p, i) => i).filter((i) => i > 0 && P[i] && !P[i].sea && g.prov.ctrl[i] >= 0 && g.prov.ctrl[i] !== g.player).slice(0, 6); })()`);
  for (const p of foeLand) await js(`${G}.order({ type: 'offensive', army: ${oArmy}, path: [${p}] })`);
  await sleep(600);
  const rowOf = `(() => { const c = document.querySelector('.cq-commands'); const r = c.getBoundingClientRect(); const kids = [...c.children].filter((x) => x.getClientRects().length && getComputedStyle(x).display !== 'none');
    const tops = kids.map((x) => Math.round(x.getBoundingClientRect().top)); const out = kids.filter((x) => { const b = x.getBoundingClientRect(); return b.right > r.right + 1 || b.bottom > r.bottom + 1; }).map((x) => x.className);
    return { h: Math.round(r.height), lines: Math.max(...tops) - Math.min(...tops) < 20 ? 1 : 2, out, btn: document.querySelector('.cq-offs-btn')?.textContent || null, chips: document.querySelectorAll('.cq-commands .cq-off').length }; })()`;
  const row1 = await js(rowOf);
  check(foeLand.length === 6 && row1.h <= 46 && row1.lines === 1 && row1.out.length === 0 && row1.chips === 0 && /6/.test(row1.btn || ''), `at 1024x720 with six offensives the command row is one line with one Offensives button and nothing cut off (${S({ ...row1, n: foeLand.length })})`);
  await ctx.click('.cq-offs-btn');
  await until(shown('.cq-offs-pop .cq-off .cq-launch'), 'the offensives list', 5000);
  const firstOff = await js(`document.querySelector('.cq-offs-pop .cq-off').dataset.offensive`);
  await ctx.click(`.cq-offs-pop .cq-off[data-offensive="${firstOff}"] .cq-launch`);
  await until(`${G}.me.armies.find((a) => a.id === ${oArmy}).offensives.find((o) => o.id === ${firstOff})?.on === true`, 'the offensive launched from the list', 5000).catch(() => {});
  await until(`/Stop/.test(document.querySelector('.cq-offs-pop .cq-off[data-offensive="${firstOff}"] .cq-launch')?.textContent || '')`, 'the Stop button', 5000).catch(() => {});
  await ctx.click(`.cq-offs-pop .cq-off[data-offensive="${firstOff}"] .cq-launch`);
  await until(`${shown('.cq-offs-clear')}`, 'Remove Finished', 5000).catch(() => {});
  const offList = await js(`({ rows: [...document.querySelectorAll('.cq-offs-pop .cq-off')].map((r) => [r.dataset.offensive, r.dataset.state, r.querySelector('.cq-off-state').textContent]), clear: ${shown('.cq-offs-clear')} ? document.querySelector('.cq-offs-clear').textContent : null })`);
  if (offList.clear) await ctx.click('.cq-offs-clear');
  await sleep(600);
  const offsLeft = await js(`${G}.me.armies.find((a) => a.id === ${oArmy}).offensives.map((o) => o.id)`);
  check(offList.rows.length === 6 && offList.rows.find((r) => r[0] === firstOff)?.[1] === 'stopped' && /\(1\)/.test(offList.clear || '') && offsLeft.length === 5 && !offsLeft.includes(Number(firstOff)),
    `the list launches and stops an offensive, marks it stopped, and Remove Finished clears it (${S({ offList, offsLeft })})`);
  await js(`(async () => { for (const o of ${G}.me.armies.find((a) => a.id === ${oArmy}).offensives) await ${G}.order({ type: 'offensive', army: ${oArmy}, offensive: o.id, path: null }); return true; })()`);
  await ctx.cdp('Emulation.clearDeviceMetricsOverride', {});
  await sleep(500);

  // ---------- settings ----------
  await ctx.click('.cq-settings');
  await until(`!!document.querySelector('.cq-settings-page input[data-pause="event"]')`, 'the Conquest settings page', 10000);
  const evOn = await js(`document.querySelector('.cq-settings-page input[data-pause="event"]').checked`);
  if (!evOn) await clickIn(ctx, '.cq-settings-page input[data-pause="event"]');
  await ctx.click('#settingsApply');
  await sleep(300);
  const live = await js(`({ pop: document.querySelector('.cq-pause-row input[data-kind="event"]').checked, diff: document.querySelector('.cq-settings-difficulty').textContent })`);
  await clickIn(ctx, '.cq-settings-page input[data-key="conquest.autosave"]');
  await ctx.click('.dialog-buttons button.primary');
  await until(`!document.querySelector('.cq-settings-page')`, 'the settings closed', 5000);
  await js(`(${G}.setSpeed(3), Conquest.ui.shell.alert('event', 'A test event'), true)`);
  await sleep(200);
  const paused = await js(`${G}.speed`);
  check(live.pop && paused === 0 && live.diff === 'Normal', `a pause-on kind applied in Settings pauses the game at once, and the alerts' own switch shows it (${S({ live, paused })})`);
  const files0 = autosaves().length;
  const off2 = await js(`${G}.autosave()`);
  await sleep(500);
  check(off2.code === 'off' && autosaves().length === files0, `with autosave off no autosave is written (${S({ off2, files: [files0, autosaves().length] })})`);
  await js(`(ide.settings.set('conquest.autosave', true), true)`);

  // ---------- autosaves per game ----------
  const ids = [];
  for (let i = 0; i < 2; i++) {
    await newGame(ctx);
    ids.push(await js(`${G}.meta.game`));
    const r = await js(`${G}.autosave()`);
    if (!r.ok) console.log(`autosave: ${S(r)}`);
    await sleep(300);
  }
  const two = autosaves();
  // Deep in the map when quitting, as after a war: the start screen shows the whole world again.
  await js(`(${V}.camera.centerOn(${V}.map.provinces[${G}.scenario.nations[${G}.player].capital].x, ${V}.map.provinces[${G}.scenario.nations[${G}.player].capital].y, 6), ${V}.redraw(), true)`);
  await ctx.click('.cq-quit');
  await until(`!!document.querySelector('.dialog-buttons button.primary')`, 'the quit question', 5000);
  await ctx.click('.dialog-buttons button.primary');
  await until(`${G}.status === 'none' && ${shown('.cq-continue')}`, 'the start screen with Continue', 30000);
  await sleep(300);
  const startCam = await js(`(() => { const c = ${V}.camera; return { scale: c.scale, min: c.minScale }; })()`);
  check(startCam.scale === startCam.min, `back on the start screen the map shows the whole world, not the game's last close view (${S(startCam)})`);
  const cont = await js(`document.querySelector('.cq-continue').dataset.save`);
  await ctx.click('.cq-continue');
  await until(`${G}.running`, 'the continued game', 60000);
  const loaded = await js(`${G}.meta.game`);
  check(ids[0] !== ids[1] && two.includes(`Autosave ${ids[0]}.ncq`) && two.includes(`Autosave ${ids[1]}.ncq`) && cont === `Autosave ${ids[1]}` && loaded === ids[1],
    `two new games leave two autosaves and Continue loads the newer (${S({ ids, two, cont, loaded })})`);
  for (let i = 1; i <= 6; i++) { await js(`ide.api.invoke('conquest:save', 'Autosave Cap ${i}', '{}')`); await sleep(40); }
  const capped = autosaves();
  check(capped.length === 5 && capped[0] === 'Autosave Cap 6.ncq', `old autosaves are capped to the newest five (${S(capped)})`);

  // ---------- the first-game guide ----------
  await js(`(ide.settings.set('conquest.guideDone', false), ide.settings.set('conquest.panel', null), true)`);
  await newGame(ctx);
  await until(`Conquest.ui.guide.step === 'army'`, 'the guide', 8000);
  const head = await js(`({ title: document.querySelector('.cq-guide-title')?.textContent, want: Conquest.ui.text.tr('Pick an army'), tip: document.querySelector('.cq-guide').getAttribute('title') })`);
  check(head.title === head.want && head.tip === null, `the guide's step shows its title and the card has no stray tooltip (${S(head)})`);
  const steps = [];
  const at = async (id) => { await until(`Conquest.ui.guide.step === ${S(id)}`, `the guide's ${id} step`, 10000); steps.push(id); };
  const gArmy = await js(`${G}.me.armies.slice().sort((a, b) => b.divs.length - a.divs.length)[0].id`);
  await ctx.click(`.cq-army[data-army="${gArmy}"]`);
  await at('front');
  await ctx.click('.cq-staff-front');
  await at('designer');
  await ctx.click('.cq-dock-tab[data-panel="designer"]');
  await at('template');
  await ctx.click('.cq-guide-next');
  await at('production');
  await ctx.click('.cq-dock-tab[data-panel="production"]');
  await at('factories');
  await sleep(600);
  await clickIn(ctx, '.cq-line .cq-step-plus');
  await at('offensive');
  const gb = await js(CONTACT);
  if (!(await js(`${G}.selection.army !== null`))) await ctx.click(`.cq-army[data-army="${gArmy}"]`);
  await frame(ctx, [...gb.chain, gb.enemy, gb.deep].filter(Boolean), 0.4);
  await ctx.click('.cq-draw-offensive');
  for (const id of [gb.enemy, gb.deep].filter(Boolean)) await clickAt(ctx, await anchor(ctx, id));
  await ctx.press('Enter');
  await at('launch');
  await until(shown('.cq-offs-btn'), 'the Offensives button', 5000);
  if (!(await js(shown('.cq-offs-pop .cq-off .cq-launch')))) await ctx.click('.cq-offs-btn');
  await until(shown('.cq-offs-pop .cq-off .cq-launch'), 'the launch button in the list', 5000);
  await ctx.click('.cq-offs-pop .cq-off .cq-launch');
  await at('alert');
  if (!(await js(shown('.cq-alert .cq-alert-main')))) await ctx.click('.cq-alert-badge');
  await until(shown('.cq-alert-main'), 'an alert', 5000);
  await ctx.click(await js(shown('.cq-alert .cq-alert-main')) ? '.cq-alert .cq-alert-main' : '.cq-alert-entry .cq-alert-main');
  const judgment = await js(`!!document.querySelector('.cq-dock-tab[data-panel="judgment"]')`);
  if (judgment) { await at('judgment'); await ctx.click('.cq-dock-tab[data-panel="judgment"]'); }
  await until(`Conquest.ui.guide.step === null`, 'the guide finished', 8000).catch(() => {});
  const end = await js(`({ step: Conquest.ui.guide.step, done: ide.settings.get('conquest.guideDone'), launched: ${G}.me.armies.some((a) => a.offensives.some((o) => o.on)) })`);
  check(end.step === null && end.done === true && end.launched && steps.length >= 9, `the guide's steps advance on the real actions and end with a launched offensive (${S({ steps, end, judgment })})`);
  await js(`(ide.settings.set('conquest.guideDone', false), true)`);
  await newGame(ctx);
  await until(`Conquest.ui.guide.step === 'army'`, 'the guide again', 8000);
  await ctx.click('.cq-guide-never');
  await newGame(ctx);
  await sleep(800);
  const closed = await js(`({ step: Conquest.ui.guide.step, shown: ${shown('.cq-guide')}, done: ide.settings.get('conquest.guideDone') })`);
  check(closed.step === null && !closed.shown && closed.done === true, `Don't Show Again keeps the guide closed on the next new game (${S(closed)})`);
  done(ctx, 'panels');
  ctx.close();

  // ---------- Korean ----------
  const ko = await launch({ fixture: 'core', port: 9972, name: 'conquest-panels-ko', mode: 'conquest', lang: 'ko-KR', env: { PYIDE_CONQUEST_HOME: path.join(tempDir('conquest-panels-ko'), 'Home'), PYIDE_CONQUEST_TEST: '1' } });
  await ko.until('window.__conquestReady === true', 'the Korean start screen', 90000);
  await ko.js(`(ide.settings.set('conquest.guideDone', true), true)`);
  await newGame(ko);
  const texts = {};
  for (const id of ['production', 'designer']) {
    await openPanel(ko, id);
    texts[id] = { title: await ko.js(`document.querySelector('.cq-dock-title').textContent`), head: await ko.js(`document.querySelector('.cq-panel[data-panel="${id}"] .cq-eco-head').textContent`),
      leaks: await englishLeaks(ko, `.cq-panel[data-panel="${id}"]`, ['Conquest']) };
  }
  const barLeaks = await englishLeaks(ko, '.cq-bar, .cq-armybar', ['Conquest']);
  check(texts.production.title === '생산' && texts.designer.title === '사단 편제' && texts.production.head === '군수 공장' && !texts.production.leaks.length && !texts.designer.leaks.length && !barLeaks.length,
    `a Korean launch shows Korean in both panels and the bars (${S({ texts, barLeaks })})`);
  done(ko, 'korean');
  ko.close();
} catch (err) {
  check(false, `the suite ran to the end (${err?.stack || err})`);
}

if (errors.length) console.log(`renderer exceptions or CSP violations:\n  ${errors.join('\n  ')}`);
check(!errors.length, 'no renderer exceptions or CSP violations');
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
