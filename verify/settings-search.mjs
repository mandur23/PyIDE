// Settings search finds pages by the labels they show in the session's language, matches every word of the query
// in any order, opens the best-ranked page and highlights its matching rows. Ports 9194-9195.
import { launch, openFile } from './lib.mjs';

const results = [];
const PAGE = `document.querySelector('.settings-page').dataset.page`;
const navRows = (t) => t.js(`[...document.querySelectorAll('.settings-nav-row')].filter(n => n.offsetParent).map(n => n.dataset.page || '#' + n.dataset.group).join('|')`);
const hits = (t) => t.js(`[...document.querySelectorAll('.settings-page .settings-hit')].filter(n => n.offsetParent).map(n => n.textContent.replace(/\\s+/g, ' ').trim())`);

async function search(t, query) {
  await t.js(`(() => { const s = document.querySelector('.settings-search'); s.focus(); s.select(); })()`);
  if (query) await t.type(query);
  else await t.press('Delete');
  await t.sleep(700);
  return { page: await t.js(PAGE), nav: await navRows(t), hits: await hits(t) };
}

async function suite(t, cases) {
  await openFile(t, 'hello.py');
  await t.press('Ctrl+Alt+S');
  await t.until(`!!document.querySelector('.settings-dialog')`, 'settings dialog');
  for (const [query, expect] of cases) {
    const r = await search(t, query);
    if (process.env.PROBE) console.log(JSON.stringify({ query, ...r }));
    expect(r, query);
  }
}

const t = await launch({ fixture: 'core', port: 9194, name: 'settings-search' });
const { check } = t;
try {
  await suite(t, [
    ['tab size', (r, q) => check(r.page === 'codestyle' && r.hits.some((h) => h.startsWith('Tab size / Indent:')), `"${q}" opens Code Style and highlights Tab size / Indent (${JSON.stringify(r)})`)],
    ['size tab', (r, q) => check(r.page === 'codestyle', `"${q}" matches the words in any order (${r.page})`)],
    ['font size', (r, q) => check(r.page === 'editor' && r.hits.some((h) => h.startsWith('Size:')), `"${q}" opens Editor › General at the Font section's Size (${JSON.stringify(r)})`)],
    ['font', (r, q) => check(r.page === 'editor' && r.hits[0] === 'Font', `"${q}" ranks Editor › General first (${JSON.stringify(r)})`)],
    ['shortcut', (r, q) => check(r.nav === 'keymap' && r.page === 'keymap', `"${q}" still finds only Keymap by its keyword (${r.nav})`)],
    ['soft-wrap', (r, q) => check(r.page === 'editor' && r.hits.some((h) => h.startsWith('Soft-wrap files')), `"${q}" finds a check box label (${JSON.stringify(r)})`)],
    ['qwxyz', (r, q) => check(r.nav === '' && r.hits.length === 0, `"${q}" matches no page (${r.nav})`)],
    ['', (r) => check(r.nav.includes('appearance|language') && r.hits.length === 0, 'an empty search shows every page again without highlights')],
  ]);
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${JSON.stringify(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
}
results.push(...t.results);
t.close();

const k = await launch({ fixture: 'core', port: 9195, name: 'settings-search-ko', lang: 'ko-KR' });
try {
  await suite(k, [
    ['탭 크기', (r, q) => k.check(r.page === 'codestyle' && r.hits.some((h) => h.startsWith('탭 크기 / 들여쓰기:')), `"${q}" opens 코드 스타일 and highlights 탭 크기 / 들여쓰기 (${JSON.stringify(r)})`)],
    ['글꼴 크기', (r, q) => k.check(r.page === 'editor' && r.hits.some((h) => h.startsWith('크기:')), `"${q}" opens 에디터 › 일반 at 글꼴 › 크기 (${JSON.stringify(r)})`)],
    ['글꼴', (r, q) => k.check(r.page === 'editor' && r.hits[0] === '글꼴', `"${q}" ranks 에디터 › 일반 first (${JSON.stringify(r)})`)],
    ['줄 번호', (r, q) => k.check(r.nav !== '' && r.hits.some((h) => h.includes('줄 번호')), `"${q}" finds the page that mentions line numbers and highlights it (${JSON.stringify(r)})`)],
    ['크기 탭', (r, q) => k.check(r.page === 'codestyle', `"${q}" matches the words in any order (${r.page})`)],
  ]);
  await k.cdp('Emulation.setDeviceMetricsOverride', { width: 1008, height: 681, deviceScaleFactor: 1, mobile: false });
  await k.until(`innerWidth === 1008 && Math.abs(innerHeight - 681) <= 1`, 'viewport 1008x681');
  const small = await search(k, '글꼴 크기');
  const shown = await k.js(`(() => { const p = document.querySelector('.settings-page').getBoundingClientRect(); const h = document.querySelector('.settings-page .settings-hit').getBoundingClientRect();
    return h.top >= p.top && h.bottom <= p.bottom && h.left >= p.left && h.right <= p.right + 0.5; })()`);
  k.check(small.page === 'editor' && shown, `at 1008x681 the highlighted row is in view inside the page (${JSON.stringify(small)})`);
  await k.shot('settings-search-ko-small.png');
  k.check(k.consoleErrors.length === 0, `no renderer exceptions (ko)${k.consoleErrors.length ? ` ${JSON.stringify(k.consoleErrors)}` : ''}`);
  await k.shot('settings-search-ko.png');
} catch (err) {
  k.check(false, err.message);
}
results.push(...k.results);
k.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
