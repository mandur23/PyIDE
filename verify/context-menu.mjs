// The editor context menu (Monaco's, drawn in a shadow root next to the editor): it has an opaque background in the
// dark and light themes, in the main editor and in a compare view, and its items keep the English order in Korean.
import { launch, openFile } from './lib.mjs';

const menuState = `(() => {
  const host = [...document.querySelectorAll('.shadow-root-host')].find((h) => h.shadowRoot?.querySelector('.monaco-menu'));
  if (!host) return null;
  const sr = host.shadowRoot;
  const opaque = (n) => { const c = getComputedStyle(n).backgroundColor; return c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent'; };
  const painted = [...sr.querySelectorAll('.monaco-menu-container, .monaco-menu-container *')].find(opaque);
  return { opaque: !!painted, color: painted ? getComputedStyle(painted).backgroundColor : '',
    items: [...sr.querySelectorAll('.action-item .action-label')].map((n) => n.textContent.trim()).filter(Boolean) };
})()`;

async function rightClick(t, selector) {
  const p = await t.js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + 120, y: r.y + 40 }; })()`);
  await t.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  for (const type of ['mousePressed', 'mouseReleased']) await t.cdp('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'right', clickCount: 1 });
  await t.until(`!!${menuState}?.items.length`, 'context menu');
  const s = await t.js(menuState);
  await t.press('Escape');
  await t.until(`!${menuState}`, 'context menu closed').catch(() => {});
  return s;
}

const before = (items, a, b) => items.indexOf(a) >= 0 && items.indexOf(a) < items.indexOf(b);

let earlier = [];
for (const lang of ['en-US', 'ko']) {
  const t = await launch({ fixture: 'nav-tests', port: 9298, name: `context-menu-${lang}`, lang });
  t.results.push(...earlier);
  const { check, js, until } = t;
  try {
    const L = lang === 'ko'
      ? { bm: '북마크 토글', mn: '니모닉으로 북마크 토글', paste: '붙여넣기', hist: '기록에서 붙여넣기...' }
      : { bm: 'Toggle Bookmark', mn: 'Toggle Bookmark with Mnemonic', paste: 'Paste', hist: 'Paste from History…' };
    await openFile(t, 'shapes/figures.py');
    const dark = await rightClick(t, '.editor-host .monaco-editor .view-lines');
    check(dark.opaque, `${lang}: the editor context menu has a background in the dark theme (${dark.color})`);
    await t.shot('menu-dark.png');
    check(before(dark.items, L.bm, L.mn), `${lang}: ${L.bm} comes before ${L.mn}`);
    const hist = dark.items.find((s) => s.startsWith(L.hist.replace(/(\.\.\.|…)$/, '')));
    check(before(dark.items, L.paste, hist), `${lang}: ${L.paste} comes before ${hist}`);

    await js(`(ide.settings.set('appearance.theme', 'light'), true)`);
    await until(`document.documentElement.dataset.theme === 'light'`, 'light theme');
    const light = await rightClick(t, '.editor-host .monaco-editor .view-lines');
    check(light.opaque && light.color !== dark.color, `${lang}: it has the light theme's background in the light theme (${light.color})`);
    await js(`(ide.settings.set('appearance.theme', 'dark'), true)`);
    await until(`document.documentElement.dataset.theme === 'dark'`, 'dark theme');

    if (lang === 'en-US') {
      await js(`(ide.compare.texts({ id: 'ctx-menu-diff', title: 'diff', left: { title: 'a', text: 'x = 1\\ny = 2\\n' }, right: { title: 'b', text: 'x = 1\\ny = 3\\n' }, language: 'python' }), true)`);
      await until(`!!document.querySelector('.monaco-diff-editor .modified .view-lines')`, 'compare view');
      const diff = await rightClick(t, '.monaco-diff-editor .modified .view-lines');
      check(diff.opaque, `the compare view's context menu has a background (${diff.color})`);
    }
  } catch (err) {
    check(false, `${lang}: ${err.message}`);
  }
  if (lang === 'ko') t.finish();
  else { t.close(); earlier = t.results; }
}
