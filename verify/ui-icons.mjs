// UI icons: the sidebar, tool window toolbars, editor tabs, menus and run widget draw PyCharm New UI SVG icons, not
// text glyphs or emoji, and an icon with colors of its own follows the theme.
import { launch, openFile } from './lib.mjs';

const t = await launch({ fixture: 'core', port: 9630, name: 'ui-icons' });
const { js, until, check, shot } = t;
const S = JSON.stringify;
// Buttons in `sel` that draw no SVG, by their tooltip.
const textOnly = (sel) => js(`[...document.querySelectorAll(${S(sel)})].filter((b) => !b.querySelector('svg')).map((b) => b.title || b.dataset.tooltip || b.textContent)`);
try {
  await until(`document.querySelector('#tree .node')`, 'project tree');
  const stripe = await textOnly('.stripe-btn');
  check(!stripe.length, `every tool window has an SVG icon on the sidebar${stripe.length ? `: ${stripe.join(', ')}` : ''}`);

  const bare = [];
  for (const id of ['Project', 'Structure', 'TODO', 'Problems', 'Notifications', 'Bookmarks', 'Launchers', 'Terminal']) {
    await js(`(ide.toolWindows.get(${S(id)})?.show(), true)`);
    await until(`ide.toolWindows.get(${S(id)})?.isVisible()`, `${id} shown`);
    const rows = await textOnly('.panel-actions button');
    bare.push(...rows.map((r) => `${id}: ${r}`));
  }
  check(!bare.length, `tool window toolbar actions draw SVG icons${bare.length ? `: ${bare.join(', ')}` : ''}`);
  check(await js(`!!document.querySelector('#bottomActions button .ide-icon[data-icon-name="splitRight"]')`), 'the Terminal toolbar has the Split Right icon');

  await openFile(t, 'hello.py');
  const tabBits = await textOnly('.group-actions button');
  check(!tabBits.length, `the editor group's Split and More draw SVG icons${tabBits.length ? `: ${tabBits.join(', ')}` : ''}`);

  await js(`(document.querySelector('.run-target').click(), true)`);
  await until(`document.querySelector('.context-menu .menu-item')`, 'run widget menu');
  const items = await js(`[...document.querySelectorAll('.context-menu .menu-item')].map((r) => ({ label: r.firstChild.textContent, svg: !!r.querySelector('.menu-icon svg'), text: r.querySelector('.menu-icon').textContent.trim() }))`);
  const current = items.find((i) => i.label === 'Current File');
  check(current?.svg && !items.some((i) => /^[^\x00-\x7f]+\s/.test(i.label)), `run widget menu items show icons, not glyphs in their labels (${S(items)})`);
  await js(`(document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)`);

  const fills = () => js(`(() => { const i = ide.icon('rerun'); document.body.appendChild(i);
    const svg = [...i.querySelectorAll('svg')].find((s) => s.getBoundingClientRect().width > 0);
    const fill = [...svg.querySelectorAll('[fill^="#"]')].map((p) => p.getAttribute('fill')).find((f) => f !== '#F2FCF3' && f !== '#253627');
    i.remove(); return fill; })()`);
  const darkFill = await fills();
  await js(`(ide.settings.set('appearance.theme', 'light'), true)`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'light theme');
  const lightFill = await fills();
  check(darkFill === '#57965C' && lightFill === '#208A3C', `a colored icon shows the drawing of the theme (dark ${darkFill}, light ${lightFill})`);
  await shot('icons-light.png');
  await js(`(ide.settings.set('appearance.theme', 'dark'), true)`);
  await until(`document.documentElement.dataset.theme === 'dark'`, 'dark theme');
  await shot('icons-dark.png');

  const plugin = await js(`[ide.icon('⟳').textContent, ide.icon('noSuchIcon').textContent, ide.icon('noSuchIcon', '★').textContent]`);
  check(S(plugin) === S(['⟳', '', '★']), `a plugin's text glyph shows as text, an unknown name as nothing or its fallback (${S(plugin)})`);
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${S(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
}
t.finish();
