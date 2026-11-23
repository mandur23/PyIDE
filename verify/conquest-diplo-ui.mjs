// The diplomacy side of Nano Studio Conquest through its screens (ui/panel-diplomacy.js, ui/panel-judgment.js,
// ui/endgame.js, ui/dip-ui.js, the queries memory/nation/calls/peace/explain in sim/queries.js, conquest:wording in
// main/features/conquest.js), with real mouse and key events on a small generated map whose relations, offers, memory
// and decisions are set by hand through the worker's test message (PYIDE_CONQUEST_TEST). Two calls to arms arrive as
// alerts with a count on the diplomacy tab; accepting one puts us at war with the named nation and refusing the other
// is remembered. Every action button against three relation states agrees with the `legal` query and shows its
// translated reason. The offer preview equals the worker's `evaluate` and follows the terms; a peace taking a
// province picked on the map is accepted as predicted and hands the province over; the reply is shown, and the LLM
// wording is asked only with the setting on (a stand-in Claude Code CLI answers, fails or hangs; the real service is
// never called). Trust and grudge follow the `memory` query and move after a betrayal. The judgment panel shows a
// nation's decision with options, the chosen mark and translated factors, a province in it focuses the map, and the
// worker hides that nation's operations until the game ends. The end screen shows the outcome query's scores and
// Keep Watching runs time on. Korean in both panels. Screenshots conquest-diplomacy-dark.png, -light.png and
// conquest-judgment-dark.png in verify/out. Ports 9921-9922.
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
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
const GEN = { seed: 21, provinces: 60, nations: 5 };

// ---------- the stand-in Claude Code CLI ----------
const fake = tempDir('conquest-diplo-claude');
const fakeJs = path.join(fake, 'fake-claude.mjs');
writeFileSync(fakeJs, `import fs from 'fs';
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) stdin += c;
const dir = ${S(fake)};
fs.appendFileSync(dir + '/calls.log', JSON.stringify({ stdin }) + '\\n');
const mode = fs.existsSync(dir + '/mode.txt') ? fs.readFileSync(dir + '/mode.txt', 'utf8').trim() : 'answer';
if (mode === 'fail') { process.stderr.write('stand-in failure'); process.exit(1); }
if (mode === 'timeout') await new Promise((r) => setTimeout(r, 60000));
const nation = (stdin.match(/^Nation: (.*)$/m) || [])[1] || '?';
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'Stand-in words for ' + nation + '. A second sentence.' }) + '\\n');
`);
const fakeCmd = path.join(fake, 'claude.cmd');
writeFileSync(fakeCmd, `@echo off\r\n"${process.execPath}" "${fakeJs}" %*\r\n`);
writeFileSync(path.join(fake, 'calls.log'), '');
const fakeMode = (m) => writeFileSync(path.join(fake, 'mode.txt'), m);
const fakeCalls = () => readFileSync(path.join(fake, 'calls.log'), 'utf8').split('\n').filter(Boolean).length;
fakeMode('answer');

const envFor = (name) => ({ PYIDE_CONQUEST_HOME: path.join(tempDir(name), 'Home'), PYIDE_CONQUEST_TEST: '1', PYIDE_CLAUDE_PATH: fakeCmd, PYIDE_CONQUEST_WORDING_MS: '2500' });

const mouse = (ctx, type, x, y, extra = {}) => ctx.cdp('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1, ...extra });
async function clickAt(ctx, p) {
  await mouse(ctx, 'mouseMoved', p.x, p.y);
  await sleep(30);
  await mouse(ctx, 'mousePressed', p.x, p.y, { buttons: 1 });
  await mouse(ctx, 'mouseReleased', p.x, p.y, { buttons: 0 });
  await sleep(150);
}
const pagePoint = (ctx, mx, my) => ctx.js(`(() => { const r = document.querySelector('.cq-map').getBoundingClientRect(); const [x, y] = ${V}.camera.toScreen(${mx}, ${my});
  return { x: r.left + x, y: r.top + y }; })()`);
const anchor = async (ctx, id) => { await ctx.js(`(${V}.focus(${id}), ${V}.redraw(), true)`); await sleep(150); const p = await ctx.js(`(({ x, y }) => ({ x, y }))(${V}.map.provinces[${id}])`); return pagePoint(ctx, p.x + 0.5, p.y + 0.5); };
const shown = (sel) => `(() => { const n = document.querySelector(${S(sel)}); return !!n && !n.closest('[hidden]') && n.getClientRects().length > 0; })()`;
const relKey = (a, b) => `N0${Math.min(a, b) + 1}|N0${Math.max(a, b) + 1}`;
const REL = (patch) => ({ war: false, ally: false, access: false, truce: 0, since: 0, broke: -1, brokeBy: -1, ...patch });

async function startGame(ctx) {
  await ctx.until('window.__conquestReady === true', 'the start screen', 90000);
  const ok = await ctx.js(`(async () => { const g = await ${G}.generate(${S(GEN)});
    return ${G}.newGame({ scenario: 'generated', gen: ${S(GEN)}, player: 0, seed: 5, difficulty: 'normal', data: { source: 'generated', map: g.map, scenario: g.scenario, idSource: Conquest.view.rasterize(g.map) } }); })()`);
  await ctx.until(`${G}.running`, 'the generated game', 60000);
  await sleep(400);
  return ok;
}
const setState = (ctx, set) => ctx.js(`${G}.debug.setState(${S(set)})`);
const runUntil = async (ctx, expr, label, maxHours) => {
  const end = (await ctx.js(`${G}.hour`)) + maxHours;
  await ctx.js(`${G}.setSpeed(4), true`);
  let ok = false;
  try {
    await ctx.until(`(${expr}) || ${G}.hour >= ${end} || ${G}.status !== 'running'`, label, 120000);
    ok = await ctx.js(`!!(${expr})`);
  } finally { await ctx.js(`${G}.setSpeed(0), true`); }
  await sleep(300);
  return ok;
};
const openTab = async (ctx, id) => {
  if (!(await ctx.js(`!!document.querySelector('.cq-dock-tab[data-panel="${id}"].active')`))) await ctx.click(`.cq-dock-tab[data-panel="${id}"]`);
  await ctx.until(shown(`.cq-panel[data-panel="${id}"]`), `the ${id} panel`, 10000);
};
const pickNation = async (ctx, n) => {
  await ctx.js(`document.querySelector('.cq-dip-nation[data-nation="${n}"]')?.scrollIntoView({ block: 'nearest' }), true`);
  await tap(ctx, `.cq-dip-nation[data-nation="${n}"]`);
  await ctx.until(`document.querySelector('.cq-dip-body')?.dataset.nation === '${n}'`, `nation ${n} picked`, 10000);
  await sleep(500);
};
const tap = async (ctx, sel) => { await ctx.js(`document.querySelector(${S(sel)})?.scrollIntoView({ block: 'center' }), true`); await sleep(80); await ctx.click(sel); };
const shoot = async (ctx, file) => { const r = await ctx.cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(OUT, file), Buffer.from(r.result.data, 'base64')); console.log(`screenshot: ${path.join(OUT, file)}`); };
// Visible text of the panels that reads as one of text.js's keys: a hyphenated key anywhere, a one-word key alone.
const rawKeys = (ctx, sel) => ctx.js(`(() => { const keys = Conquest.ui.text.KEYS; const out = [];
  for (const root of document.querySelectorAll(${S(sel)})) { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) { const p = n.parentElement; if (!p || p.closest('[hidden]') || !p.getClientRects().length) continue; const t = n.textContent.trim(); if (!t) continue;
      for (const k of keys) { if (k.includes('-') ? new RegExp('(^|[^\\\\w-])' + k + '($|[^\\\\w-])').test(t) : t === k) out.push(k + ' in ' + t); } } }
  return out; })()`);

try {
  mkdirSync(OUT, { recursive: true });
  const ctx = await launch({ fixture: 'core', port: 9921, name: 'conquest-diplo-ui', mode: 'conquest', env: envFor('conquest-diplo-ui') });
  const { js, until } = ctx;
  await startGame(ctx);
  await js(`(() => { window.__wording = 0; const inv = ide.api.invoke; ide.api.invoke = (ch, ...a) => { if (ch === 'conquest:wording') window.__wording++; return inv(ch, ...a); }; return true; })()`);
  const names = await js(`${G}.scenario.nations.map((n) => n.name)`);

  // ---------- two calls to arms ----------
  await setState(ctx, [
    { path: ['rel', relKey(0, 1)], value: REL({ ally: true, access: true }) },
    { path: ['rel', relKey(0, 3)], value: REL({ ally: true, access: true }) },
    { path: ['rel', relKey(1, 2)], value: REL({ war: true }) },
    { path: ['rel', relKey(2, 3)], value: REL({ war: true }) },
    { path: ['nations', 4, 'bloc'], value: 'entente' },
    { path: ['offers'], value: [{ id: 1, from: 1, to: 0, action: 'call-to-arms', terms: { against: 2 }, hour: 0, expires: 720 }, { id: 2, from: 3, to: 0, action: 'call-to-arms', terms: { against: 2 }, hour: 0, expires: 720 }] },
    { path: ['diplo', 'nextOffer'], value: 3 },
    { path: ['memory', 3], value: [{ hour: 0, about: 2, kind: 'attacked-us', value: 1000 }] },
  ]);
  await until(`document.querySelectorAll('.cq-alert[data-kind="offer"]').length === 2`, 'two offer alerts', 10000);
  const badge = await js(`({ n: getComputedStyle(document.querySelector('.cq-app')).getPropertyValue('--cq-dip-offers').trim(), on: document.querySelector('.cq-app').classList.contains('cq-dip-has-offers'),
    after: getComputedStyle(document.querySelector('.cq-dock-tab[data-panel="diplomacy"]'), '::after').content })`);
  check(badge.n === '2' && badge.on && badge.after !== 'none', `two waiting offers put a count of 2 on the diplomacy tab (${S(badge)})`);
  await ctx.click('.cq-alert[data-kind="offer"] .cq-alert-main');
  await until(`${shown('.cq-panel[data-panel="diplomacy"] .cq-dip-inbox')} && document.querySelectorAll('.cq-dip-inbox .cq-dip-offer').length === 2`, 'the inbox opened by the alert', 10000);
  const card = await js(`(() => { const c = document.querySelector('.cq-dip-inbox .cq-dip-offer[data-offer="1"]'); return { text: c.textContent, exp: c.querySelector('.cq-dip-offer-exp').textContent, means: c.querySelector('.cq-dip-offer-means').textContent }; })()`);
  check(card.text.includes(names[1]) && card.means.includes(names[2]) && /Answer by/.test(card.exp), `the alert opens the inbox: who asks, against whom, when it expires and what accepting means (${S(card)})`);
  await tap(ctx, '.cq-dip-offer[data-offer="1"] .cq-dip-accept');
  await until(`${G}.nations[2].war === true`, 'at war with the named nation', 10000);
  const rel2 = await js(`${G}.query('relations', { nation: 0 }).then((r) => r.find((x) => x.nation === 2))`);
  check(rel2.war && (await js(`${G}.offers.some((o) => o.id === 1)`)) === false, `accepting the call to arms puts us at war with ${names[2]} (${S(rel2)})`);
  await until(`!!document.querySelector('.cq-dip-offer[data-offer="2"] .cq-dip-refuse')`, 'the second offer', 5000);
  await tap(ctx, '.cq-dip-offer[data-offer="2"] .cq-dip-refuse');
  await until(`!${G}.offers.length`, 'no offers left', 10000);
  const refused = await js(`(async () => ({ log: ${G}.log.some((e) => e.kind === 'refused' && e.offer === 2), mem: (await ${G}.query('memory', { nation: 3 })).filter((e) => e.about === 0).map((e) => e.kind),
    badge: document.querySelector('.cq-app').classList.contains('cq-dip-has-offers'), inbox: ${shown('.cq-dip-inbox')} }))()`);
  check(refused.log && refused.mem.includes('broke-promise') && !refused.badge && !refused.inbox, `refusing the other call is logged and ${names[3]} remembers a broken promise; the count is gone (${S(refused)})`);
  await pickNation(ctx, 3);
  const ledger3 = await js(`[...document.querySelectorAll('.cq-dip-ledger-row')].map((r) => ({ kind: r.dataset.kind, text: r.textContent }))`);
  check(ledger3.some((l) => l.kind === 'broke-promise' && l.text.includes(names[0])), `its ledger shows the broken promise (${S(ledger3)})`);

  // ---------- every action button against three relation states ----------
  const ACTS = ['declare-war', 'offer-alliance', 'break-alliance', 'ask-access', 'call-to-arms', 'offer-peace', 'join-bloc'];
  const walk = [];
  for (const n of [1, 2, 4]) {
    await pickNation(ctx, n);
    const rows = await js(`(() => { const out = {}; for (const r of document.querySelectorAll('.cq-dip-actions .cq-dip-action')) out[r.dataset.action] = { disabled: r.querySelector('button').disabled, why: r.querySelector('.cq-dip-why').textContent, against: r.querySelector('select')?.value ?? null }; return out; })()`);
    for (const a of ACTS) {
      const x = rows[a];
      const bloc = await js(`${G}.nations[${n}].bloc`);
      const order = a === 'call-to-arms' ? { type: 'diplo', action: a, to: n, against: x.against === null || x.against === '' ? -1 : Number(x.against) }
        : a === 'offer-peace' ? { type: 'diplo', action: a, to: n, terms: { take: [], give: [] } } : a === 'join-bloc' ? { type: 'diplo', action: a, bloc: bloc || '' } : { type: 'diplo', action: a, to: n };
      const want = a === 'join-bloc' && !bloc ? { ok: false, text: await js(`ide.t('It is in no bloc.')`) } : await js(`${G}.query('legal', { order: ${S(order)} })`);
      const text = want.ok ? '' : want.text || await js(`Conquest.ui.text.reason(${S(want.reason)})`);
      walk.push({ n, a, ok: !x.disabled === !!want.ok && x.why === text, shown: x, want });
    }
  }
  const bad = walk.filter((w) => !w.ok);
  const okCounts = [1, 2, 4].map((n) => walk.filter((w) => w.n === n && w.want.ok).map((w) => w.a));
  check(!bad.length && okCounts.every((l) => l.length > 0) && S(okCounts[0]) !== S(okCounts[1]), `every action is enabled exactly when legal says ok, else shows its translated reason, for an ally, an enemy and a neutral (${S({ bad, okCounts })})`);
  const leave = await js(`(() => { const r = document.querySelector('.cq-dip-self .cq-dip-action'); return { disabled: r.querySelector('button').disabled, why: r.querySelector('.cq-dip-why').textContent }; })()`);
  check(leave.disabled && leave.why === (await js(`Conquest.ui.text.reason('no-bloc')`)), `Leave Bloc is refused with its reason while we are in no bloc (${S(leave)})`);
  const ready = await js(`(() => { const l = document.querySelector('.cq-dip-self .cq-dip-ready-label'); const r = ${G}.nations[${G}.player].ready; return { shown: l.textContent, value: r, want: 'Readiness: ' + Conquest.ui.text.percent(r), tip: l.title.length > 0 }; })()`);
  check(ready.shown === ready.want && ready.value >= 0 && ready.value <= 1000 && ready.tip, `our nation's readiness is shown as the worker reports it, with an explanation (${S(ready)})`);

  // ---------- the preview of an offer ----------
  await pickNation(ctx, 4);
  await tap(ctx, '.cq-dip-action[data-action="offer-alliance"] button');
  await until(`document.querySelector('.cq-dip-preview')?.dataset.score !== undefined && ${shown('.cq-dip-proposal')}`, 'the alliance preview', 10000);
  await sleep(300);
  const readPreview = () => js(`(() => { const p = document.querySelector('.cq-dip-preview'); return { score: Number(p.dataset.score), threshold: Number(p.dataset.threshold), accept: p.dataset.accept === 'true', verdict: p.querySelector('.cq-dip-verdict').textContent,
    factors: [...p.querySelectorAll('.cq-dip-factor')].map((f) => ({ label: f.dataset.label, delta: Number(f.dataset.delta), text: f.textContent })) }; })()`);
  const same = (pv, ev) => pv.score === ev.score && pv.threshold === ev.threshold && pv.accept === ev.accept
    && S(pv.factors.slice(1).map((f) => [f.label, f.delta])) === S(ev.factors.map((f) => [f.label, f.delta])) && pv.factors[0].label === 'base' && pv.factors[0].delta === ev.score - ev.factors.reduce((s, f) => s + f.delta, 0);
  const pvA = await readPreview();
  const evA = await js(`${G}.query('evaluate', { to: 4, action: 'offer-alliance', terms: {} })`);
  check(same(pvA, evA) && new RegExp(`^Would (accept|refuse): ${(evA.score / 1000).toFixed(2)} of ${(evA.threshold / 1000).toFixed(2)}$`).test(pvA.verdict), `the alliance preview equals the worker's evaluate: score, threshold and factors (${S({ pvA, evA })})`);
  await tap(ctx, '.cq-dip-proposal .cq-dip-cancel');

  await setState(ctx, [{ path: ['nations', 2, 'fatigue'], value: 700 }]);
  await pickNation(ctx, 2);
  await tap(ctx, '.cq-dip-action[data-action="offer-peace"] button');
  await until(`document.querySelector('.cq-dip-proposal')?.dataset.action === 'offer-peace' && document.querySelector('.cq-dip-preview')?.dataset.score !== undefined`, 'the peace preview', 10000);
  await sleep(400);
  const pv0 = await readPreview();
  const ev0 = await js(`${G}.query('evaluate', { to: 2, action: 'offer-peace', terms: { take: [], give: [] } })`);
  const target = await js(`(() => { const g = ${G}; const P = g.map.provinces; const cap = g.scenario.nations[2].capital; const busy = new Set([...g.divs.values()].map((d) => d.prov)); for (let p = 1; p < P.length; p++) if (!P[p].sea && g.prov.owner[p] === 2 && p !== cap && !busy.has(p)) return p; for (let p = 1; p < P.length; p++) if (!P[p].sea && g.prov.owner[p] === 2 && p !== cap) return p; return 0; })()`);
  await clickAt(ctx, await anchor(ctx, target));
  await until(`!!document.querySelector('.cq-dip-take .cq-dip-term[data-province="${target}"]')`, 'the clicked province in the terms', 10000);
  await until(`Number(document.querySelector('.cq-dip-preview').dataset.score) !== ${pv0.score}`, 'the preview after the term', 10000).catch(() => {});
  await sleep(400);
  const pv1 = await readPreview();
  const ev1 = await js(`${G}.query('evaluate', { to: 2, action: 'offer-peace', terms: { take: [${target}], give: [] } })`);
  check(same(pv0, ev0) && same(pv1, ev1) && pv1.score !== pv0.score && pv1.factors.some((f) => f.label === 'terms'),
    `the peace preview equals evaluate, and a province clicked on the map joins the terms and changes it (${S({ before: [pv0.score, ev0.score], after: [pv1.score, ev1.score], terms: pv1.factors.find((f) => f.label === 'terms') })})`);
  await tap(ctx, '.cq-dip-wide-btn');
  await sleep(300);
  const wide = await js(`document.querySelector('.cq-dock-body').getBoundingClientRect().width`);
  check(wide >= 700, `Wide View widens the dock (${wide} px)`);
  await js(`document.querySelector('.cq-dip-preview').scrollIntoView({ block: 'end' }), true`);
  await sleep(300);
  await shoot(ctx, 'conquest-diplomacy-dark.png');
  await js(`(ide.settings.set('appearance.theme', 'light'), true)`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'the light theme', 5000);
  await sleep(500);
  await shoot(ctx, 'conquest-diplomacy-light.png');
  const lum = await js(`(() => { const l = (c) => { const [r, g, b] = c.match(/\\d+/g).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const v = document.querySelector('.cq-dip-verdict'); const t = document.querySelector('.cq-dip-factor-text'); const box = document.querySelector('.cq-dip-proposal');
    return { verdict: l(getComputedStyle(v).color), text: l(getComputedStyle(t).color), box: l(getComputedStyle(box).backgroundColor) }; })()`);
  check(Math.abs(lum.text - lum.box) > 90 && Math.abs(lum.verdict - lum.box) > 50, `the proposal reads in the light theme (${S(lum)})`);
  await js(`(ide.settings.set('appearance.theme', 'dark'), true)`);
  await tap(ctx, '.cq-dip-wide-btn');

  await tap(ctx, '.cq-dip-proposal .cq-dip-send');
  await until(`${G}.offers.some((o) => o.from === 0 && o.action === 'offer-peace')`, 'the peace offer sent', 10000);
  const peaceId = await js(`${G}.offers.find((o) => o.from === 0 && o.action === 'offer-peace').id`);
  const answered = await runUntil(ctx, `${G}.log.some((e) => (e.kind === 'accepted' || e.kind === 'refused') && e.offer === ${peaceId})`, 'the answer to the peace', 72);
  await until(`document.querySelector('.cq-dip-reply')?.dataset.offer === '${peaceId}'`, 'the reply shown', 10000).catch(() => {});
  const peace = await js(`({ accepted: ${G}.log.some((e) => e.kind === 'accepted' && e.offer === ${peaceId}), owner: ${G}.prov.owner[${target}], war: ${G}.nations[2].war,
    reply: document.querySelector('.cq-dip-reply')?.dataset.offer === '${peaceId}' ? document.querySelector('.cq-dip-reply-canned').textContent : null, llm: ${shown('.cq-dip-reply-llm')} })`);
  check(answered && peace.accepted === pv1.accept && peace.accepted, `the peace is answered as the preview predicted (${pv1.accept ? 'accept' : 'refuse'}) (${S(peace)})`);
  check(peace.owner === 0 && !peace.war, `the province in the terms is ours on the map after the peace (${S(peace)})`);
  check(!!peace.reply && peace.reply.includes(names[2]) && /accepts the peace/.test(peace.reply), `the canned reply is shown (${peace.reply})`);
  check((await js('window.__wording')) === 0 && fakeCalls() === 0 && !peace.llm, `with the LLM setting off no wording is asked at all (${S({ ipc: await js('window.__wording'), cli: fakeCalls() })})`);

  // ---------- the LLM wording ----------
  const offerTo4 = async (action) => {
    await setState(ctx, [{ path: ['rel', relKey(0, 4)], value: REL({}) }]);
    await pickNation(ctx, 4);
    await tap(ctx, `.cq-dip-action[data-action="${action}"] button`);
    await until(`document.querySelector('.cq-dip-proposal')?.dataset.action === '${action}' && !document.querySelector('.cq-dip-send').disabled`, `the ${action} proposal`, 10000);
    await tap(ctx, '.cq-dip-proposal .cq-dip-send');
    await until(`${G}.offers.some((o) => o.from === 0 && o.to === 4)`, `the ${action} offer sent`, 10000);
    const id = await js(`${G}.offers.find((o) => o.from === 0 && o.to === 4).id`);
    await runUntil(ctx, `${G}.log.some((e) => (e.kind === 'accepted' || e.kind === 'refused') && e.offer === ${id})`, `the answer to ${action}`, 72);
    await until(`document.querySelector('.cq-dip-reply')?.dataset.offer === '${id}'`, 'its reply shown', 10000);
    return id;
  };
  await tap(ctx, '.cq-dip-llm-toggle');
  check((await js(`ide.settings.get('conquest.llmReplies', false)`)) === true, 'the LLM setting turns on from its checkbox');
  fakeMode('answer');
  await offerTo4('ask-access');
  await until(`${shown('.cq-dip-reply-llm')}`, 'the LLM line', 15000).catch(() => {});
  const llm = await js(`({ text: document.querySelector('.cq-dip-reply-llm-text').textContent, mark: document.querySelector('.cq-dip-llm-mark').textContent, canned: document.querySelector('.cq-dip-reply-canned').textContent, shown: ${shown('.cq-dip-reply-llm')} })`);
  const asked = JSON.parse(readFileSync(path.join(fake, 'calls.log'), 'utf8').split('\n').filter(Boolean).pop() || '{}').stdin || '';
  check(llm.shown && llm.text === `Stand-in words for ${names[4]}. A second sentence.` && llm.mark === 'Worded by Claude' && llm.canned.includes(names[4]) && (await js('window.__wording')) === 1,
    `with the setting on the stand-in's wording shows under the canned line, marked as written by Claude (${S(llm)})`);
  check(/^Nation: /m.test(asked) && /^Year: 1914$/m.test(asked) && /^Plain reply: /m.test(asked) && !/province|division|\bhour\b/i.test(asked), `the wording request carries only the nation, year, decision, reasons and the canned line (${S(asked)})`);
  fakeMode('fail');
  await offerTo4('offer-alliance');
  await sleep(1500);
  const failed = await js(`({ llm: ${shown('.cq-dip-reply-llm')}, canned: document.querySelector('.cq-dip-reply-canned').textContent, asking: ${shown('.cq-dip-reply-asking')} })`);
  check(!failed.llm && failed.canned.includes(names[4]) && !failed.asking && (await js('window.__wording')) === 2, `a failing stand-in leaves the canned line alone (${S(failed)})`);
  fakeMode('timeout');
  await offerTo4('ask-access');
  await sleep(4500);
  const timedOut = await js(`({ llm: ${shown('.cq-dip-reply-llm')}, canned: document.querySelector('.cq-dip-reply-canned').textContent, asking: ${shown('.cq-dip-reply-asking')} })`);
  check(!timedOut.llm && timedOut.canned.includes(names[4]) && !timedOut.asking && (await js('window.__wording')) === 3, `a stand-in that never answers times out and the canned line stays (${S(timedOut)})`);
  await tap(ctx, '.cq-dip-llm-toggle');
  fakeMode('answer');

  // ---------- trust, grudge and a betrayal ----------
  await setState(ctx, [{ path: ['rel', relKey(0, 3)], value: REL({ ally: true, access: true }) }]);
  await pickNation(ctx, 3);
  const meters = () => js(`({ trust: Number(document.querySelector('.cq-dip-meter-trust.cq-dip-us').dataset.value), grudge: Number(document.querySelector('.cq-dip-meter-grudge.cq-dip-us').dataset.value) })`);
  const feelings = () => js(`${G}.query('memory', { nation: 3, summary: true }).then((m) => ({ trust: m.trust[0], grudge: m.grudge[0] }))`);
  const m0 = await meters();
  const f0 = await feelings();
  check(S(m0) === S(f0), `trust and grudge shown for ${names[3]} match the memory query (${S({ m0, f0 })})`);
  await ctx.js(`document.querySelector('.cq-dip-third').value = '2', document.querySelector('.cq-dip-third').dispatchEvent(new Event('change')), true`);
  await sleep(500);
  const third = await js(`(async () => ({ shown: Number(document.querySelector('.cq-dip-meter-grudge.cq-dip-them').dataset.value), want: (await ${G}.query('memory', { nation: 3, summary: true })).grudge[2] }))()`);
  check(third.shown === third.want && third.want > 0, `its grudge toward a third nation matches the query (${S(third)})`);
  await tap(ctx, '.cq-dip-action[data-action="break-alliance"] button');
  await until(`!!document.querySelector('.dialog-buttons button.primary')`, 'the break question', 5000);
  await ctx.click('.dialog-buttons button.primary');
  await until(`${G}.nations[3].ally === false`, 'the alliance broken', 10000);
  await sleep(500);
  await tap(ctx, '.cq-dip-action[data-action="declare-war"] button');
  await until(`!!document.querySelector('.cq-dip-war-confirm')`, 'the war confirmation', 5000);
  const confirm = await js(`({ ours: document.querySelector('.cq-dip-war-ours').dataset.nations, theirs: document.querySelector('.cq-dip-war-theirs').dataset.nations, betrayal: !!document.querySelector('.cq-dip-war-betrayal'), text: document.querySelector('.cq-dip-war-confirm').textContent })`);
  const calls = await js(`${G}.query('calls', { to: 3 })`);
  check(confirm.ours === calls.ours.join(',') && confirm.theirs === calls.theirs.join(',') && confirm.betrayal && calls.betrayal && confirm.text.includes(names[calls.ours[0] ?? 1] || ''),
    `the declaration asks first and lists who is called in on both sides, with the betrayal warning (${S({ confirm, calls })})`);
  await ctx.click('.dialog-buttons button.primary');
  await until(`${G}.nations[3].war === true`, 'at war with the old ally', 10000);
  await until(`[...document.querySelectorAll('.cq-dip-ledger-row')].some((r) => r.dataset.kind === 'betrayal')`, 'the betrayal in the ledger', 10000).catch(() => {});
  const m1 = await meters();
  const f1 = await feelings();
  const line = await js(`[...document.querySelectorAll('.cq-dip-ledger-row')].map((r) => ({ kind: r.dataset.kind, text: r.textContent }))[0]`);
  check(line?.kind === 'betrayal' && line.text.includes(`${names[0]} betrayed us`) && S(m1) === S(f1) && m1.trust < m0.trust && m1.grudge > m0.grudge,
    `after the betrayal its ledger's newest line is the betrayal and the meters moved as the memory query says (${S({ line, m0, m1, f1 })})`);

  // ---------- the diplomacy map mode ----------
  await ctx.click('.cq-mode[data-mode="diplomacy"]');
  const e4 = await js(`(() => { const g = ${G}; const P = g.map.provinces; const busy = new Set([...g.divs.values()].map((d) => d.prov)); return P.findIndex((p, i) => p && !p.sea && g.prov.owner[i] === 4 && !busy.has(i)); })()`);
  await clickAt(ctx, await anchor(ctx, e4));
  await until(`document.querySelector('.cq-dip-body')?.dataset.nation === '4'`, 'the nation picked on the map', 10000).catch(() => {});
  check((await js(`document.querySelector('.cq-dip-body')?.dataset.nation`)) === '4', 'in the diplomacy map mode a click on its land picks the nation');
  await ctx.click('.cq-mode[data-mode="political"]');

  // ---------- the judgment panel ----------
  const prov2 = await js(`(() => { const g = ${G}; const P = g.map.provinces; for (let p = P.length - 1; p > 0; p--) if (P[p] && !P[p].sea && g.prov.ctrl[p] === 1) return p; return 1; })()`);
  const DEC = [
    { hour: 30, layer: 'operations', chosen: { label: 'offensive-toward', args: { army: 1, offensive: 1, province: prov2, from: prov2, to: prov2, nation: 1 } }, options: [{ label: 'offensive-section', args: { from: prov2, to: prov2, province: prov2 }, score: 700 }], factors: [{ label: 'terrain', args: { province: prov2 }, delta: -120 }] },
    { hour: 40, layer: 'nation', chosen: { label: 'declare-war', args: { nation: 1 } }, options: [{ label: 'declare-war', args: { nation: 1 }, score: 900 }, { label: 'declare-war', args: { nation: 4 }, score: 400 }, { label: 'keep-peace', score: 620 }],
      factors: [{ label: 'goal', delta: 500 }, { label: 'grudge', args: { nation: 1 }, delta: 300 }, { label: 'terrain', args: { province: prov2 }, delta: -100 }] },
  ];
  await setState(ctx, [{ path: ['nations', 2, 'ai', 'decisions'], value: DEC }]);
  await pickNation(ctx, 2);
  await openTab(ctx, 'judgment');
  await until(`document.querySelector('.cq-jdg')?.dataset.nation === '2' && document.querySelectorAll('.cq-jdg-card').length > 0`, 'the judgment of nation 2', 10000);
  await sleep(400);
  const jd = await js(`(() => { const c = [...document.querySelectorAll('.cq-jdg-card')].find((x) => x.dataset.label === 'declare-war' && x.dataset.layer === 'nation'); if (!c) return null;
    return { chosen: c.querySelector('.cq-jdg-chosen').textContent, options: [...c.querySelectorAll('.cq-jdg-option')].map((o) => ({ label: o.dataset.label, score: Number(o.dataset.score), chosen: o.classList.contains('chosen'), text: o.textContent })),
      factors: [...c.querySelectorAll('.cq-dip-factor')].map((f) => ({ label: f.dataset.label, delta: Number(f.dataset.delta), text: f.textContent })), layer: c.querySelector('.cq-jdg-layer').textContent,
      ops: document.querySelectorAll('.cq-jdg-card[data-layer="operations"]').length, hiddenNote: ${shown('.cq-jdg-hidden')} }; })()`);
  check(jd && jd.chosen === `Declare war on ${names[1]}` && jd.options.length === 3 && jd.options[0].chosen && !jd.options[1].chosen && jd.options[2].text.includes('Keep the peace')
    && S(jd.factors.map((f) => [f.label, f.delta])) === S([['goal', 500], ['grudge', 300], ['terrain', -100]]) && jd.factors[1].text.includes(`Grudge against ${names[1]}`) && jd.factors[0].text.includes('+0.50')
    && jd.layer === 'Nation' && jd.ops === 0 && jd.hiddenNote, `the judgment panel shows the decision with its options, the chosen mark and translated factors, and no operations plan (${S(jd)})`);
  const raw = await rawKeys(ctx, '.cq-jdg, .cq-dip');
  check(!raw.length, `no raw label key is visible in either panel (${S(raw.slice(0, 5))})`);
  const hiddenOps = await js(`(async () => ({ explain: (await ${G}.query('explain', { nation: 2 })).map((d) => d.layer), plans: await ${G}.query('plans', { nation: 2 }).then(() => 'answered', (e) => e.message),
    message: await new Promise((r) => { const w = ${G}.debug.worker; const f = (e) => { if (e.data?.type === 'explained' && e.data.id === 777001) { w.removeEventListener('message', f); r(e.data.decisions.map((d) => d.layer)); } }; w.addEventListener('message', f); w.postMessage({ type: 'explain', id: 777001, nation: 2 }); }) }))()`);
  check(!hiddenOps.explain.includes('operations') && hiddenOps.explain.includes('nation') && hiddenOps.plans === 'hidden' && !hiddenOps.message.includes('operations'),
    `before the end the worker answers neither another nation's operations decisions nor its plans (${S(hiddenOps)})`);
  await js(`document.querySelector('.cq-jdg-card[data-label="declare-war"] .cq-dip-link')?.scrollIntoView({ block: 'nearest' }), true`);
  await tap(ctx, '.cq-jdg-card[data-label="declare-war"] .cq-dip-link');
  await sleep(300);
  check((await js(`${G}.selection.province`)) === prov2, `clicking the province named in a factor focuses the map on it (${await js(`${G}.selection.province`)} = ${prov2})`);
  await shoot(ctx, 'conquest-judgment-dark.png');

  // ---------- an offer refused, offered again, and one that stops fitting ----------
  await js(`(ide.settings.set('conquest.pauseOn', { war: false, offer: true, lost: false, taken: false, 'battle-lost': false, 'low-supply': false, event: false }), Conquest.ui.shell.openAlerts(null), true)`);
  const h1 = await js(`${G}.hour`);
  const peaceFrom = (id, from) => ({ id, from, to: 0, action: 'offer-peace', terms: { take: [], give: [] }, hour: h1, expires: h1 + 720 });
  const offerToasts = `[...document.querySelectorAll('.cq-alerts-list .cq-alert[data-kind="offer"]')].map((r) => r.textContent)`;
  const offerCount = `Number(document.querySelector('.cq-alert-badge[data-kind="offer"] .cq-alert-count')?.textContent || 0)`;
  await setState(ctx, [{ path: ['rel', relKey(0, 1)], value: REL({ war: true }) }, { path: ['rel', relKey(0, 2)], value: REL({ war: true }) }, { path: ['offers'], value: [] }]);
  await js(`(document.querySelectorAll('.cq-alerts-list .cq-alert-close').forEach((b) => b.click()), true)`);
  await sleep(300);
  const base = await js(offerCount);
  await js(`${G}.setSpeed(2), true`);
  await setState(ctx, [{ path: ['offers'], value: [peaceFrom(9101, 1)] }]);
  await until(`(${offerCount}) === ${base + 1}`, 'the first peace offer', 10000);
  await sleep(300);
  const first = await js(`({ speed: ${G}.speed, toasts: ${offerToasts} })`);
  await openTab(ctx, 'diplomacy');
  await until(shown('.cq-dip-offer[data-offer="9101"] .cq-dip-refuse'), 'the offer card', 10000);
  await tap(ctx, '.cq-dip-offer[data-offer="9101"] .cq-dip-refuse');
  await until(`!${G}.offers.some((o) => o.id === 9101)`, 'the refusal', 10000);
  await js(`${G}.setSpeed(2), true`);
  await setState(ctx, [{ path: ['offers'], value: [peaceFrom(9102, 1)] }]);
  await until(`(${offerCount}) === ${base + 2}`, 'the same offer again', 10000);
  await sleep(500);
  const again = await js(`({ speed: ${G}.speed, toasts: ${offerToasts}, tag: document.querySelector('.cq-dip-offer[data-offer="9102"] .cq-dip-again')?.textContent || null,
    accept: !document.querySelector('.cq-dip-offer[data-offer="9102"] .cq-dip-accept')?.disabled })`);
  await js(`${G}.setSpeed(0), true`);
  check(first.speed === 0 && first.toasts.length === 1 && again.speed === 2 && again.toasts.length === 0 && again.tag === 'Offered again: 2 times' && again.accept,
    `a peace offer refused once comes again from the same nation without pausing or a toast, counted under the badge and marked in the inbox (${S({ first, again })})`);
  await js(`${G}.setSpeed(2), true`);
  await setState(ctx, [{ path: ['offers'], value: [peaceFrom(9102, 1), peaceFrom(9103, 2)] }]);
  await until(`(${offerCount}) === ${base + 3}`, 'a first offer from another nation', 10000);
  await sleep(300);
  const other = await js(`({ speed: ${G}.speed, toasts: (${offerToasts}).length })`);
  check(other.speed === 0 && other.toasts === 1, `the first offer of a kind from another nation still pauses and stays as a toast (${S(other)})`);
  // Peace with nation 2 comes another way: its offer stops fitting, leaves the list on the next day, and shows as expired.
  await setState(ctx, [{ path: ['rel', relKey(0, 2)], value: REL({ war: false }) }]);
  await runUntil(ctx, `!${G}.offers.some((o) => o.id === 9103)`, 'the stale offer dropped', 30);
  await sleep(500);
  const stale = await js(`(() => { const c = document.querySelector('.cq-dip-offer[data-offer="9103"]'); return { card: !!c, expired: !!c?.classList.contains('expired'), accept: c?.querySelector('.cq-dip-accept')?.disabled, refuse: c?.querySelector('.cq-dip-refuse')?.disabled,
    why: c?.querySelector('.cq-dip-offer-dead')?.textContent || null, toasts: (${offerToasts}).length }; })()`);
  check(stale.card && stale.expired && stale.accept === true && stale.refuse === true && /No longer valid/.test(stale.why || '') && stale.toasts === 0,
    `an offer overtaken by events stays in the inbox as expired with the reason and its buttons off, and its toast leaves (${S(stale)})`);
  await shoot(ctx, 'conquest-offers-inbox-dark.png');

  // ---------- the end ----------
  const relSet = await js(`(() => { const g = ${G}; const tags = g.nations.map((n) => n.tag); const out = []; for (let a = 0; a < tags.length; a++) for (let b = a + 1; b < tags.length; b++) out.push({ path: ['rel', tags[a] < tags[b] ? tags[a] + '|' + tags[b] : tags[b] + '|' + tags[a]], value: { war: false, ally: false, access: false, truce: g.hour + 9000, since: 0, broke: -1, brokeBy: -1 } }); return out; })()`);
  const hourNow = await js(`${G}.hour`);
  await setState(ctx, [...relSet, { path: ['offers'], value: [] }, { path: ['diplo', 'warSeen'], value: true }, { path: ['diplo', 'lastWar'], value: hourNow - 31 * 24 }, { path: ['nations', 2, 'ai', 'decisions'], value: DEC }]);
  const ended = await runUntil(ctx, `!!${G}.outcome`, 'the end of the game', 96);
  await until(shown('.cq-end'), 'the end screen', 10000).catch(() => {});
  const end = await js(`(async () => { const o = await ${G}.query('outcome'); return { o, speed: ${G}.speed, rows: [...document.querySelectorAll('.cq-end-row[data-nation]')].map((r) => ({ n: Number(r.dataset.nation), me: r.classList.contains('me'),
    cols: Object.fromEntries([...r.querySelectorAll('[data-col]')].map((c) => [c.dataset.col, c.dataset.value])) })), sub: document.querySelector('.cq-end-sub').textContent, timeline: document.querySelectorAll('.cq-end-timeline .cq-log-row').length }; })()`);
  const scoreOk = end.o && end.o.scores.every((s) => { const r = end.rows.find((x) => x.n === s.nation); return r && ['goals', 'cores', 'land', 'industry', 'manpower', 'total'].every((k) => r.cols[k] === String(s[k])); });
  check(ended && end.o?.kind === 'general-peace' && end.speed === 0 && scoreOk && end.rows.filter((r) => r.me).map((r) => r.n).join() === '0' && /Peace has returned/.test(end.sub) && end.timeline > 0,
    `when the game ends it pauses on a screen with the outcome query's scores, our row marked, and the timeline (${S({ kind: end.o?.kind, speed: end.speed, rows: end.rows.length, sub: end.sub, timeline: end.timeline })})`);
  const endView = await js(`(() => { const t = document.querySelector('.cq-end-table'); const kids = [...t.children]; const rows = kids.filter((x) => x.dataset.nation);
    const vis = (x) => !x.hidden && x.getClientRects().length > 0; const me = rows.find((r) => r.classList.contains('me'));
    return { verdict: document.querySelector('.cq-end-verdict')?.textContent || null, mine: document.querySelector('.cq-end-mine')?.textContent || null, result: document.querySelector('.cq-end').dataset.result,
      firstRow: rows[0]?.dataset.nation, meTag: me?.querySelector('.cq-end-tag')?.textContent || null, order: kids.map((x) => x.dataset.nation ? (vis(x) ? 'r' : 'h') + x.dataset.nation : x.dataset.group || (x.classList.contains('cq-end-neutrals') ? 'N' : 'head')),
      majors: rows.filter((r) => vis(r) && Conquest.game.scenario.nations[Number(r.dataset.nation)].major).map((r) => r.dataset.nation),
      neutralBtn: document.querySelector('.cq-end-neutrals')?.textContent || null,
      offers: { toasts: document.querySelectorAll('.cq-alerts-list .cq-alert[data-kind="offer"]').length, live: [...document.querySelectorAll('.cq-dip-accept, .cq-dip-refuse')].filter((b) => !b.disabled).length } }; })()`);
  const nm = await js(`Conquest.game.nationName(0)`);
  check(endView.verdict === 'No side won: the war ended in a general peace.' && endView.result === 'none' && endView.firstRow === '0' && endView.meTag === 'Your nation' && endView.mine?.startsWith(`${nm} ends `)
    && endView.order[0] === 'head' && endView.order[1] === 'r0', `the end screen says first who won and how our nation ended, with our row pinned on top and marked (${S(endView)})`);
  const gi = (g) => endView.order.indexOf(g);
  const neutralRows = endView.order.slice(gi('N') + 1);
  check((gi('majors') < 0 || gi('majors') < (gi('fought') < 0 ? Infinity : gi('fought'))) && (gi('N') < 0 || (neutralRows.length > 0 && neutralRows.every((x) => x.startsWith('h')) && /Show the neutral nations/.test(endView.neutralBtn || '')))
    && endView.offers.toasts === 0 && endView.offers.live === 0, `the table lists the great powers at war, then the other nations at war, the neutrals folded behind a button, and no offer can be answered (${S({ order: endView.order, btn: endView.neutralBtn, offers: endView.offers })})`);
  if (gi('N') >= 0) {
    await tap(ctx, '.cq-end-neutrals');
    const opened = await js(`[...document.querySelectorAll('.cq-end-row[data-nation]')].filter((r) => r.hidden).length`);
    check(opened === 0, `the neutrals button shows the neutral rows (${opened} still hidden)`);
  }
  const verdicts = await js(`(() => { const n = Conquest.game.nations; const keep = n.map((x) => [x.bloc, x.casualties]); n[0].bloc = 'a'; n[1].bloc = 'b'; n[1].casualties = 5;
    const v = Conquest.ui.endgame.verdict; const out = [v({ kind: 'bloc-defeated', bloc: 'b' }).result, v({ kind: 'bloc-defeated', bloc: 'a' }).result, v({ kind: 'end-date' }).result];
    keep.forEach(([b, c], i) => { n[i].bloc = b; n[i].casualties = c; }); return out; })()`);
  check(S(verdicts) === S(['won', 'lost', 'none']), `the verdict is won when the other bloc is defeated, lost when ours is, none at the last day (${S(verdicts)})`);
  const after = await js(`(async () => ({ explain: (await ${G}.query('explain', { nation: 2 })).map((d) => d.layer), plans: await ${G}.query('plans', { nation: 2 }).then((p) => Array.isArray(p), (e) => e.message) }))()`);
  check(after.explain.includes('operations') && after.plans === true, `after the end the worker answers its operations decisions and plans (${S(after)})`);
  await tap(ctx, '.cq-end-plans-toggle');
  await sleep(400);
  check(await js(`document.querySelector('.cq-end-plans-toggle').checked`), 'Show their plans can be switched on');
  const h0 = await js(`${G}.hour`);
  await tap(ctx, '.cq-end-watch');
  await sleep(2000);
  const watch = await js(`({ hour: ${G}.hour, speed: ${G}.speed, shown: ${shown('.cq-end')}, reopen: ${shown('.cq-end-reopen')} })`);
  check(watch.hour > h0 && watch.speed > 0 && !watch.shown && watch.reopen, `Keep Watching hides the screen and time runs on (${S({ h0, ...watch })})`);
  await js(`${G}.setSpeed(0), true`);
  done(ctx, 'english');
  ctx.close();

  // ---------- Korean ----------
  {
    const k = await launch({ fixture: 'core', port: 9922, name: 'conquest-diplo-ui-ko', mode: 'conquest', lang: 'ko-KR', env: envFor('conquest-diplo-ui-ko') });
    await startGame(k);
    await k.js(`${G}.debug.setState(${S([
      { path: ['rel', relKey(0, 1)], value: REL({ ally: true, access: true }) },
      { path: ['rel', relKey(1, 2)], value: REL({ war: true }) },
      { path: ['offers'], value: [{ id: 1, from: 1, to: 0, action: 'call-to-arms', terms: { against: 2 }, hour: 0, expires: 720 }] },
      { path: ['diplo', 'nextOffer'], value: 2 },
      { path: ['memory', 2], value: [{ hour: 0, about: 0, kind: 'attacked-us', value: 1000 }] },
      { path: ['nations', 2, 'ai', 'decisions'], value: [{ hour: 10, layer: 'nation', chosen: { label: 'declare-war', args: { nation: 0 } }, options: [{ label: 'declare-war', args: { nation: 0 }, score: 900 }, { label: 'keep-peace', score: 620 }], factors: [{ label: 'grudge', args: { nation: 0 }, delta: 300 }] }] },
    ])})`);
    await k.until(`document.querySelectorAll('.cq-alert[data-kind="offer"]').length === 1`, 'the Korean offer alert', 10000);
    await k.click('.cq-alert[data-kind="offer"] .cq-alert-main');
    await k.until(shown('.cq-dip-inbox'), 'the Korean inbox', 10000);
    await pickNation(k, 2);
    const ko = await k.js(`({ inbox: document.querySelector('.cq-dip-inbox .cq-dip-section-title').textContent, accept: document.querySelector('.cq-dip-accept').textContent, war: document.querySelector('.cq-dip-action[data-action="declare-war"] button').textContent,
      ledger: document.querySelector('.cq-dip-ledger-row')?.textContent || '' })`);
    const leaksD = await englishLeaks(k, '.cq-dip', ['Claude']);
    await openTab(k, 'judgment');
    await k.until(`document.querySelectorAll('.cq-jdg-card').length > 0`, 'the Korean judgment', 10000);
    await sleep(400);
    const kj = await k.js(`({ chosen: document.querySelector('.cq-jdg-chosen').textContent, layer: document.querySelector('.cq-jdg-layer').textContent, title: document.querySelector('.cq-dock-title').textContent })`);
    const leaksJ = await englishLeaks(k, '.cq-jdg', ['Claude']);
    check(ko.inbox === '받은 제안' && ko.accept === '제안 수락' && ko.war === '선전 포고' && /우리를 공격함/.test(ko.ledger) && /선전 포고$/.test(kj.chosen) && kj.layer === '나라' && kj.title === '판단 보기' && !leaksD.length && !leaksJ.length,
      `both panels speak Korean (${S({ ko, kj, leaksD: leaksD.slice(0, 5), leaksJ: leaksJ.slice(0, 5) })})`);

    // A scenario event left to the player (skipIfPlayer) is asked as a decision: the game pauses, the dialog names
    // the nations, Declare War sends the orders and Not Now leaves it to the Diplomacy panel; each is asked once.
    const MARCH = { id: 'march', once: true, skipIfPlayer: 'N01', when: { not: { war: ['N01', 'N04'] } }, effects: [{ declareWar: ['N01', 'N04'] }] };
    const startWithEvent = async () => {
      await k.js(`(async () => { const g = await ${G}.generate(${S(GEN)}); g.scenario.events = [${S(MARCH)}];
        return ${G}.newGame({ scenario: 'generated', gen: ${S(GEN)}, player: 0, seed: 5, difficulty: 'normal', data: { source: 'generated', map: g.map, scenario: g.scenario, idSource: Conquest.view.rasterize(g.map) } }); })()`);
      await k.until(`${G}.running`, 'the game with an event', 60000);
    };
    const DLG = '.dialog .cq-decision[data-decision="march"]';
    const atWar = `!!${G}.nations[3].war`;
    await startWithEvent();
    await k.until(shown(DLG), 'the decision dialog', 20000);
    const asked = await k.js(`({ speed: ${G}.speed, nations: document.querySelector(${S(DLG)}).dataset.nations, text: document.querySelector(${S(DLG)}).textContent, name: ${G}.nationName(3), war: ${atWar}, kept: ${G}.meta.decisions })`);
    check(asked.speed === 0 && asked.nations === '3' && asked.text.includes(asked.name) && !asked.war && asked.kept.includes('march'), `an event left to the player opens a decision with the game paused, naming the nation, before any war (${S({ ...asked, text: asked.text.slice(0, 60) })})`);
    await k.click('.dialog:has(.cq-decision) .dialog-buttons button.primary');
    await k.until(atWar, 'the declared war', 20000);
    check(!(await k.js(shown(DLG))), 'Declare War declares it and closes the dialog');
    await startWithEvent();
    await k.until(shown(DLG), 'the decision dialog again in a new game', 20000);
    await k.click('.dialog:has(.cq-decision) .dialog-buttons button.secondary');
    await sleep(300);
    const h1 = await k.js(`${G}.hour`);
    await runUntil(k, `${G}.hour >= ${h1 + 72}`, 'three game days after Not Now', 96);
    const later = await k.js(`({ dialog: ${shown(DLG)}, war: ${atWar}, hour: ${G}.hour })`);
    check(!later.dialog && !later.war && later.hour >= h1 + 72, `Not Now closes it without a war and it is not asked again on later days (${S(later)})`);
    done(k, 'korean');
    k.close();
  }
} catch (err) {
  check(false, `the suite ran to the end (${err?.stack || err})`);
}

if (errors.length) console.log(`renderer exceptions or CSP violations:\n  ${errors.join('\n  ')}`);
check(!errors.length, 'no renderer exceptions or CSP violations');
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
