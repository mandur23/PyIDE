// Sidebar (tool window stripe): only pinned windows show, the rest are behind "More"; pins persist; icons are SVG.
import { launch } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';

const visibleButtons = (t) => t.js(`[...document.querySelectorAll('#stripe .stripe-btn[data-tool]')].filter(b => !b.classList.contains('hidden')).map(b => b.dataset.tool)`);
const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };

let a;
try {
  a = await launch({ fixture: 'core', port: 9520, name: 'sidebar' });
  const all = await a.js(`[...ide.toolWindows.keys()]`);
  const shown = await visibleButtons(a);
  check(all.length >= 12 && shown.length <= 8, `sidebar shows ${shown.length} of ${all.length} tool windows (${shown.join(', ')})`);
  check(['Project', 'Commit', 'Structure', 'Run', 'Debug', 'Terminal', 'Problems'].every((id) => shown.includes(id)), 'default pinned set: Project, Commit, Structure, Run, Debug, Terminal, Problems');
  const noSvg = await a.js(`[...document.querySelectorAll('#stripe .stripe-btn')].filter(b => !b.querySelector('svg')).map(b => b.dataset.tool || b.id)`);
  check(!noSvg.length, `every sidebar button uses an SVG icon${noSvg.length ? ` (not: ${noSvg.join(', ')})` : ''}`);
  check(await a.js(`(() => { const s = getComputedStyle(document.querySelector('#stripe .stripe-btn[data-tool="Run"] svg')); return s.width === '20px'; })()`), 'icons are 20px like PyCharm New UI');
  check(await a.js(`[...document.querySelectorAll('.bottom-tab')].filter(t => !t.classList.contains('hidden')).length`) <= 5, 'bottom panel tabs follow the sidebar instead of listing every window');

  // ---------- More popup ----------
  await a.click('#stripeMore');
  await a.until(`!!document.querySelector('#moreToolWindows')`, 'more panel');
  const rows = await a.js(`[...document.querySelectorAll('#moreToolWindows .more-row')].map(r => r.dataset.tool)`);
  check(rows.length === all.length, `More lists all ${all.length} tool windows`);
  check(await a.js(`document.querySelector('#moreToolWindows .more-row[data-tool="Terminal"] .more-keys').textContent === 'Alt+F12'`), 'More shows each shortcut');
  await a.shot('more.png');
  await a.click('#moreToolWindows .more-row[data-tool="TODO"]');
  await a.until(`ide.toolWindows.get('TODO').isVisible()`, 'TODO shown');
  check(!(await a.js(`!!document.querySelector('#moreToolWindows')`)) && (await visibleButtons(a)).includes('TODO'), 'opening an unpinned window from More shows its icon while it is open');
  await a.js(`ide.toolWindows.get('TODO').hide()`);
  check(!(await visibleButtons(a)).includes('TODO'), 'its icon goes away again when it closes');

  // ---------- pin from More, unpin from the sidebar ----------
  await a.click('#stripeMore');
  await a.until(`!!document.querySelector('#moreToolWindows .more-row[data-tool="PythonConsole"] .more-pin')`, 'pin button');
  await a.click('#moreToolWindows .more-row[data-tool="PythonConsole"] .more-pin');
  await a.until(`ide.sidebar.isPinned('PythonConsole')`, 'pinned');
  check((await visibleButtons(a)).includes('PythonConsole') && await a.js(`!!document.querySelector('#moreToolWindows')`), 'the pin in More adds the window to the sidebar and keeps the list open');
  await a.press('Escape');
  check(!(await a.js(`!!document.querySelector('#moreToolWindows')`)), 'Esc closes More');
  await a.js(`document.querySelector('#stripe .stripe-btn[data-tool="Structure"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 120 }))`);
  await a.until(`!!document.querySelector('.context-menu')`, 'stripe menu');
  await a.js(`[...document.querySelectorAll('.context-menu .menu-item')].find(n => n.textContent.startsWith('Remove from Sidebar')).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  check(!(await visibleButtons(a)).includes('Structure') && !(await a.js(`ide.sidebar.isPinned('Structure')`)), 'right-click › Remove from Sidebar unpins a window');
  await a.press('Alt+7');
  check(await a.js(`ide.toolWindows.get('Structure').isVisible()`), 'shortcuts still open unpinned windows');
  check(a.consoleErrors.length === 0, 'no renderer exceptions');
  a.close();

  // ---------- persists, Korean, Light ----------
  const b = await launch({ fixture: 'core', port: 9521, name: 'sidebar-ko', userData: a.userData, lang: 'ko-KR' });
  await b.js(`(ide.settings.set('appearance.language', 'ko'), true)`);
  const pins = await b.js(`ide.sidebar.pinned()`);
  check(pins.includes('PythonConsole') && !pins.includes('Structure'), 'pinned set persists across restarts');
  b.close();
  const c = await launch({ fixture: 'core', port: 9522, name: 'sidebar-ko2', userData: a.userData, lang: 'ko-KR' });
  await c.click('#stripeMore');
  await c.until(`!!document.querySelector('#moreToolWindows')`, 'more (ko)');
  const leaks = await englishLeaks(c, '#moreToolWindows, #stripe', ['Git', 'TODO']);
  check(!leaks.length && await c.js(`document.querySelector('#stripeMore').title === '더 많은 도구 창'`), `More and sidebar are in Korean${leaks.length ? ` ${JSON.stringify(leaks)}` : ''}`);
  await c.shot('more-ko.png');
  await c.press('Escape');
  await c.js(`(ide.settings.set('appearance.theme', 'light'), true)`);
  await c.until(`document.documentElement.dataset.theme === 'light'`, 'light');
  const iconColor = await c.js(`getComputedStyle(document.querySelector('#stripe .stripe-btn[data-tool="Run"]:not(.active)')).color`);
  check(/^rgb\((\d+), \1, \1\)$|^rgb\(\d+, \d+, \d+\)$/.test(iconColor) && iconColor !== 'rgb(255, 255, 255)', `icons stay visible in Light (${iconColor})`);
  await c.click('#stripeMore');
  await c.shot('more-light.png');
  check(c.consoleErrors.length === 0, 'no renderer exceptions (Korean, Light)');
  c.close();
} catch (err) {
  check(false, err.message);
  a?.close();
}
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
