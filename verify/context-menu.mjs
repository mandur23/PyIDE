// The editor context menu: the IDE's own popup in place of Monaco's flat one (the common actions at the top, the rest
// in submenus), opened by a right click or the Menu key, with an opaque background in the dark and light themes, Korean
// titles, the caret moved as Monaco moved it, and an embedded editor (a notebook cell) offering only its editor actions.
// The compare view keeps Monaco's menu, which must still have a background. The find widget's Close tooltip must not
// cover the button (it wrapped against the editor's right edge and blinked). Port 9298.
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const J = JSON.stringify;
const ideMenu = `(() => {
  const menus = [...document.querySelectorAll('.context-menu')];
  if (!menus.length) return null;
  const rows = (m) => [...m.querySelectorAll(':scope > .menu-item')].map((r) => r.querySelector('.menu-label').textContent);
  const c = getComputedStyle(menus[0]).backgroundColor;
  return { top: rows(menus[0]), sub: menus[1] ? rows(menus[1]) : null, height: menus[0].getBoundingClientRect().height,
    opaque: c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent', color: c,
    monaco: !![...document.querySelectorAll('.shadow-root-host')].find((h) => h.shadowRoot?.querySelector('.monaco-menu')) };
})()`;
const monacoMenu = `(() => {
  const host = [...document.querySelectorAll('.shadow-root-host')].find((h) => h.shadowRoot?.querySelector('.monaco-menu'));
  if (!host) return null;
  const opaque = (n) => { const c = getComputedStyle(n).backgroundColor; return c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent'; };
  const painted = [...host.shadowRoot.querySelectorAll('.monaco-menu-container, .monaco-menu-container *')].find(opaque);
  return { opaque: !!painted, color: painted ? getComputedStyle(painted).backgroundColor : '' };
})()`;

const point = (t, selector, dx = 120, dy = 40) => t.js(`(() => { const r = document.querySelector(${J(selector)}).getBoundingClientRect(); return { x: r.x + ${dx}, y: r.y + ${dy} }; })()`);
async function mouse(t, p, button = 'right') {
  await t.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  if (button) for (const type of ['mousePressed', 'mouseReleased']) await t.cdp('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button, clickCount: 1 });
}
async function rightClick(t, selector, state = ideMenu) {
  await mouse(t, await point(t, selector));
  await t.until(`!!${state}`, `context menu on ${selector}`);
  return t.js(state);
}
async function closeMenu(t, state = ideMenu) {
  await t.sleep(100);
  await t.press('Escape');
  await t.until(`!${state}`, 'context menu closed');
}
const rowPoint = (t, level, label) => t.js(`(() => { const r = [...document.querySelectorAll('.context-menu[data-level="${level}"] > .menu-item')]
  .find((n) => n.querySelector('.menu-label').textContent === ${J(label)})?.getBoundingClientRect(); return r && { x: r.x + 20, y: r.y + r.height / 2 }; })()`);
const before = (items, ...labels) => labels.every((l, i) => items.includes(l) && (i === 0 || items.indexOf(labels[i - 1]) < items.indexOf(l)));

let earlier = [];
for (const lang of ['en-US', 'ko']) {
  const t = await launch({ fixture: 'nav-tests', port: 9298, name: `context-menu-${lang}`, lang });
  t.results.push(...earlier);
  const { check, js, until, sleep, cdp } = t;
  const ko = lang === 'ko';
  const L = ko
    ? { cut: '잘라내기', copy: '복사', paste: '붙여넣기', refactor: '리팩터링', rename: '이름 변경…', bookmarks: '북마크', toggle: '북마크 토글', mnemonic: '니모닉으로 북마크 토글', run: '컨텍스트 구성 실행' }
    : { cut: 'Cut', copy: 'Copy', paste: 'Paste', refactor: 'Refactor', rename: 'Rename…', bookmarks: 'Bookmarks', toggle: 'Toggle Bookmark', mnemonic: 'Toggle Bookmark with Mnemonic', run: 'Run Context Configuration' };
  try {
    await openFile(t, 'shapes/figures.py');
    await until(`ide.actions.some((a) => a.id === 'ToggleBookmark') && ide.actions.some((a) => a.id === 'RenameElement')`, 'plugins loaded');
    const lines = '.editor-host .monaco-editor .view-lines';

    const dark = await rightClick(t, lines);
    check(!dark.monaco, `${lang}: a right click in the editor opens the IDE's menu, not Monaco's`);
    check(dark.top.length <= 20 && dark.height < 600, `${lang}: the menu is short (${dark.top.length} rows, ${Math.round(dark.height)} px)`);
    check(dark.opaque, `${lang}: it has a background in the dark theme (${dark.color})`);
    check(before(dark.top, L.cut, L.copy, L.paste, L.refactor, L.bookmarks), `${lang}: ${L.cut}, ${L.copy}, ${L.paste} at the top, then the submenus (${dark.top.join(' | ')})`);
    check(!dark.top.includes(L.rename) && !dark.top.includes(L.toggle), `${lang}: Rename and Toggle Bookmark live in submenus`);
    check(!dark.top.includes('Git'), `${lang}: outside a Git repository the menu has no Git submenu`);
    await t.shot(`menu-${lang}.png`);
    if (ko) {
      check(!(await englishLeaks(t, '.context-menu')).length, `ko: the menu has no English text (${J(await englishLeaks(t, '.context-menu'))})`);
    }

    await mouse(t, await rowPoint(t, 0, L.refactor), null);
    await until(`${ideMenu}?.sub?.includes(${J(L.rename)})`, 'Refactor submenu');
    if (ko) check(!(await englishLeaks(t, '.context-menu')).length, 'ko: the Refactor submenu has no English text');
    await mouse(t, await rowPoint(t, 0, L.bookmarks), null);
    await until(`${ideMenu}?.sub?.includes(${J(L.toggle)})`, 'Bookmarks submenu');
    check(before((await js(ideMenu)).sub, L.toggle, L.mnemonic), `${lang}: ${L.toggle} comes before ${L.mnemonic}`);
    const caretLine = await js(`ide.editor.getPosition().lineNumber`);
    await mouse(t, await rowPoint(t, 1, L.toggle), 'left');
    await until(`!${ideMenu}`, 'menu closed after an item ran');
    const marked = await until(`ide.bookmarks.list().some((b) => b.line === ${caretLine} && ide.util.samePath(b.path, ide.activeTab().path))`, 'bookmark set from the menu').then(() => true, () => false);
    check(marked, `${lang}: Bookmarks › ${L.toggle} sets a bookmark on the clicked line (${J(await js('ide.bookmarks.list()'))})`);

    await js(`(ide.settings.set('appearance.theme', 'light'), true)`);
    await until(`document.documentElement.dataset.theme === 'light'`, 'light theme');
    const light = await rightClick(t, lines);
    check(light.opaque && light.color !== dark.color, `${lang}: it has the light theme's background in the light theme (${light.color})`);
    await closeMenu(t);
    await js(`(ide.settings.set('appearance.theme', 'dark'), true)`);
    await until(`document.documentElement.dataset.theme === 'dark'`, 'dark theme');

    if (!ko) {
      // A right click outside the selection moves the caret there; inside it keeps the selection.
      await js(`(() => { const e = ide.editor; e.setSelection(new ide.monaco.Selection(1, 1, 1, 6)); e.focus(); return true; })()`);
      const sel = await js(`(() => { const e = ide.editor; const p = e.getScrolledVisiblePosition({ lineNumber: 1, column: 3 }); const r = e.getDomNode().getBoundingClientRect(); return { x: r.x + p.left, y: r.y + p.top + p.height / 2 }; })()`);
      await mouse(t, sel);
      await until(`!!${ideMenu}`, 'menu inside the selection');
      check(await js(`!ide.editor.getSelection().isEmpty()`), 'a right click inside the selection keeps it');
      await closeMenu(t);
      const far = await js(`(() => { const e = ide.editor; const p = e.getScrolledVisiblePosition({ lineNumber: 4, column: 2 }); const r = e.getDomNode().getBoundingClientRect(); return { x: r.x + p.left, y: r.y + p.top + p.height / 2 }; })()`);
      await mouse(t, far);
      await until(`!!${ideMenu}`, 'menu outside the selection');
      check(await js(`ide.editor.getSelection().isEmpty() && ide.editor.getPosition().lineNumber === 4`), 'a right click outside the selection moves the caret to the clicked line');
      await closeMenu(t);

      await js(`(ide.editor.setPosition({ lineNumber: 4, column: 3 }), ide.editor.focus(), true)`);
      await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ContextMenu', code: 'ContextMenu', windowsVirtualKeyCode: 93 });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ContextMenu', code: 'ContextMenu', windowsVirtualKeyCode: 93 });
      await until(`!!${ideMenu}`, 'menu from the Menu key').then(() => check(true, 'the Menu key opens the menu'), () => check(false, 'the Menu key opens the menu'));
      check(!(await js(ideMenu))?.monaco, 'the Menu key opens no Monaco menu');
      const placed = await js(`(() => { const e = ide.editor; const p = e.getScrolledVisiblePosition(e.getPosition()); const r = e.getDomNode().getBoundingClientRect();
        const m = document.querySelector('.context-menu').getBoundingClientRect(); return Math.abs(m.left - (r.left + p.left)) < 8 && Math.abs(m.top - (r.top + p.top + p.height)) < 8; })()`);
      check(placed, 'the Menu key opens it below the caret');
      check(await js(`(() => { const p = ide.editor.getPosition(); return p.lineNumber === 4 && p.column === 3; })()`), 'the Menu key leaves the caret where it was');
      await sleep(100);
      await t.press('ArrowDown');
      await t.press('ArrowDown');
      check(await js(`[...document.querySelectorAll('.context-menu[data-level="0"] > .menu-item:not(.disabled)')].findIndex((n) => n.classList.contains('active')) === 1`),
        'Down moves one row at a time in a menu the Menu key opened');
      await closeMenu(t);

      // The find widget's Close sits at the editor's right edge; its tooltip must fit on one line above it.
      await js(`(ide.editor.focus(), true)`);
      await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F3', code: 'F3', windowsVirtualKeyCode: 114 });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F3', code: 'F3', windowsVirtualKeyCode: 114 });
      await until(`(() => { const b = document.querySelector('.editor-host .find-widget.visible .codicon-widget-close'); return !!b && b.getBoundingClientRect().top > ide.editor.getDomNode().getBoundingClientRect().top; })()`, 'find widget slid in');
      await sleep(300);
      const close = await point(t, '.editor-host .find-widget.visible .codicon-widget-close', 8, 8);
      await mouse(t, { x: close.x - 40, y: close.y }, null);
      await sleep(200);
      await mouse(t, close, null);
      await until(`!!document.querySelector('.workbench-hover')`, 'Close tooltip');
      const tip = await js(`(() => { const h = document.querySelector('.workbench-hover').getBoundingClientRect(); const b = document.querySelector('.editor-host .find-widget.visible .codicon-widget-close').getBoundingClientRect();
        return { overlap: h.bottom > b.top + 1 && h.top < b.bottom - 1 && h.right > b.left && h.left < b.right, height: Math.round(h.height) }; })()`);
      check(!tip.overlap && tip.height < 32, `the Close tooltip stays off the button on one line (${J(tip)})`);
      let under = 0;
      for (let i = 0; i < 15; i++) { under += await js(`document.elementFromPoint(${close.x}, ${close.y})?.classList.contains('codicon-widget-close') ? 1 : 0`); await sleep(80); }
      check(under === 15, `the Close button stays under the pointer while its tooltip shows (${under}/15)`);

      // A notebook cell is an embedded editor: its menu runs editor actions and leaves out the tab's IDE actions.
      await js(`ide.api.write(ide.util.joinPath(ide.root, 'cells.ipynb'), ${J(JSON.stringify({ cells: [{ cell_type: 'code', metadata: {}, source: ['x = 1\n', 'print(x)\n'], outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 }))})`);
      await openFile(t, 'cells.ipynb');
      await until(`!!document.querySelector('.nb-cell .monaco-editor .view-lines')`, 'notebook cell editor');
      const cell = await rightClick(t, '.nb-cell .monaco-editor .view-lines', ideMenu);
      check(!cell.monaco && before(cell.top, L.cut, L.copy, L.paste), `a notebook cell gets the IDE menu with Cut, Copy, Paste (${cell.top.join(' | ')})`);
      check(!cell.top.includes(L.run), 'a notebook cell leaves out the tab-only Run Context Configuration');
      await closeMenu(t);
      const cellEditor = `ide.monaco.editor.getEditors().find((e) => e.getDomNode()?.closest('.nb-cell'))`;
      const cellItem = async (line, column, label) => {
        await mouse(t, await js(`(() => { const e = ${cellEditor}; const p = e.getScrolledVisiblePosition({ lineNumber: ${line}, column: ${column} }); const r = e.getDomNode().getBoundingClientRect(); return { x: r.x + p.left + 2, y: r.y + p.top + p.height / 2 }; })()`));
        await until(`!!${ideMenu}`, `cell menu at ${line}:${column}`);
        await mouse(t, await rowPoint(t, 0, label), 'left');
        await until(`!${ideMenu}`, `${label} ran`);
      };
      await js(`(() => { const e = ${cellEditor}; e.setSelection(new ide.monaco.Selection(1, 1, 1, 6)); e.focus(); return true; })()`);
      await cellItem(1, 3, L.copy);
      await cellItem(2, 9, L.paste);
      const pasted = await until(`${cellEditor}.getModel().getLineContent(2) === 'print(x)x = 1'`, 'pasted into the cell').then(() => true, () => false);
      check(pasted, `Copy and Paste from a notebook cell's menu act on that cell (${J(await js(`${cellEditor}.getModel().getValue()`))})`);
      await js(`(ide.closeTab(ide.activeTab().path, true), true)`);

      await js(`(ide.compare.texts({ id: 'ctx-menu-diff', title: 'diff', left: { title: 'a', text: 'x = 1\\ny = 2\\n' }, right: { title: 'b', text: 'x = 1\\ny = 3\\n' }, language: 'python' }), true)`);
      await until(`!!document.querySelector('.monaco-diff-editor .modified .view-lines')`, 'compare view');
      const diff = await rightClick(t, '.monaco-diff-editor .modified .view-lines', monacoMenu);
      check(diff.opaque, `the compare view's context menu has a background (${diff.color})`);
      await closeMenu(t, monacoMenu).catch(() => {});

    } else {
      const missing = (await missingTranslations(t)).filter((s) => /^(Copy \/ Paste Special|Folding|Go To|Generate|AI|Bookmarks|Local History|Show History|Put Label…|Refactor)$/.test(s));
      check(!missing.length, `ko: the menu's own strings are translated (${J(missing)})`);
    }
  } catch (err) {
    check(false, `${lang}: ${err.message}`);
  }
  if (ko) t.finish();
  else { t.close(); earlier = t.results; }
}
