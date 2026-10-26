// Breadcrumbs above each editor and the Call Hierarchy tool window (renderer/features/navigation-bar), against the real
// bundled Pyright on verify/fixtures/breadcrumbs: nested classes and functions in pkg/shapes.py, and a call chain
// app.py main/report -> shapes.compute -> scale/offset. Ports 9930-9931.
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { clickMenuPath, launch, openFile } from './lib.mjs';
import { englishLeaks } from './i18n-lib.mjs';

const J = JSON.stringify;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const t = await launch({ fixture: 'breadcrumbs', port: 9930 });
const { js, until, press, click, check, shot, cdp, sleep, project } = t;
// Rendering (and with it ResizeObserver) only runs while frames are produced; the window may sit behind others.
const frames = setInterval(() => cdp('Page.captureScreenshot', { format: 'jpeg', quality: 1 }).catch(() => {}), 50);

const bar = (g = 'ide.activeGroup()') => `${g}.el.querySelector('.nb-bar')`;
const crumbs = (g) => js(`[...${bar(g)}.querySelectorAll('.nb-crumb .nb-name')].map(n => n.textContent)`);
const barShown = (g) => js(`(() => { const b = ${bar(g)}; return !!b && b.getClientRects().length > 0; })()`);
const caret = (line, col) => js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: ${col} }), true)`);
const pos = () => js(`(() => { const p = ide.editor.getPosition(); return [ide.activeTab()?.title, p.lineNumber, p.column]; })()`);
const crumbsExpr = (g) => `JSON.stringify([...${bar(g)}.querySelectorAll('.nb-crumb .nb-name')].map(n => n.textContent))`;
const crumbsAre = async (expected, label, g) => {
  try {
    await until(`${crumbsExpr(g)} === ${J(J(expected))}`, label, 15000);
    check(true, label);
  } catch { check(false, `${label} (got ${J(await crumbs(g))})`); }
};
// Marks the first element matching sel whose text contains text, then clicks it with real mouse events.
const mark = async (sel, text, root = 'document') => {
  const ok = await js(`(() => { document.querySelectorAll('[data-vt]').forEach(n => n.removeAttribute('data-vt'));
    const n = [...${root}.querySelectorAll(${J(sel)})].find(n => n.textContent.includes(${J(text)}));
    if (n) n.setAttribute('data-vt', '1'); return !!n; })()`);
  if (!ok) throw new Error(`no ${sel} containing ${text}`);
};
const clickText = async (sel, text) => { await mark(sel, text); await click('[data-vt="1"]'); };
const dblclickText = async (sel, text) => {
  await mark(sel, text);
  const box = await js(`(() => { const r = document.querySelector('[data-vt="1"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const clickCount of [1, 2]) for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount });
  await sleep(60);
};
const menuLabels = () => js(`[...document.querySelectorAll('.nb-menu .menu-item .menu-label')].map(n => n.textContent)`);
const treeRows = () => js(`[...document.querySelectorAll('#nbCallTree .nb-ch-row')].map(r => [r.dataset.name, +r.dataset.depth, r.textContent])`);

try {
  writeFileSync(path.join(project, 'logo.png'), Buffer.from(PNG, 'base64'));
  await js(`(window.__ro = 0, addEventListener('error', (e) => { if (/ResizeObserver loop/.test(e.message)) window.__ro++; }), true)`);
  check(await js(`ide.ui && !!ide.navigationBar && ide.toolWindows.has('CallHierarchy')`), 'navigation-bar plugin loaded with the Hierarchy tool window');

  // ---- breadcrumbs: path and Class › method at the caret ----
  await openFile(t, 'pkg/shapes.py');
  await until(`ide.lsp.status() === 'ready'`, 'Pyright ready', 40000);
  await caret(9, 13);
  await crumbsAre(['pkg', 'shapes.py', 'Outer', 'Inner', 'method'], 'caret in Inner.method: pkg › shapes.py › Outer › Inner › method');
  const text = (await js(`${bar()}.textContent`)).replace(/\s+/g, '');
  check(text === 'pkg›shapes.py›COuter▾›CInner▾›mmethod▾', `separators and kind icons between the crumbs (${text})`);
  check(await js(`${bar()}.querySelectorAll('.nb-crumb[data-kind=path] .file-icon').length === 2 && ${bar()}.querySelector('.nb-crumb[data-kind=path] .file-icon').dataset.type === 'folder'`), 'path crumbs carry ide.fileIcon icons (folder, then the file)');
  const geometry = () => js(`(() => { const g = ide.activeGroup(); return [${bar()}.getBoundingClientRect().height, g.el.querySelector('.group-body').getBoundingClientRect().height, ide.editor.getLayoutInfo().height]; })()`);
  const geo0 = await geometry();
  await shot('breadcrumbs.png');

  // Debounced: a burst of caret moves renders once, after the caret settles.
  await js(`(window.__renders = 0, window.__mo = new MutationObserver(() => window.__renders++), window.__mo.observe(${bar()}, { childList: true }), true)`);
  await js(`(() => { for (const [l, c] of [[13, 13], [17, 13], [22, 8], [26, 8], [17, 14]]) ide.editor.setPosition({ lineNumber: l, column: c }); return true; })()`);
  await crumbsAre(['pkg', 'shapes.py', 'Outer', 'run', 'helper'], 'caret in the nested helper(): Outer › run › helper');
  await sleep(400);
  check(await js('window.__renders') === 1, `five quick caret moves re-render the bar once (${await js('window.__renders')})`);
  await caret(22, 8);
  await crumbsAre(['pkg', 'shapes.py', 'compute'], 'caret in compute(): only the function');
  await caret(2, 1);
  await crumbsAre(['pkg', 'shapes.py'], 'caret at module level: the path only');
  await js(`(window.__mo.disconnect(), true)`);
  const geo1 = await geometry();
  check(J(geo0) === J(geo1) && geo0[0] === 24, `bar height (24px), editor area and editor layout height unchanged by updates (${J(geo0)} -> ${J(geo1)})`);

  // ---- clicking a symbol jumps; its dropdown lists sibling symbols ----
  await caret(9, 13);
  await crumbsAre(['pkg', 'shapes.py', 'Outer', 'Inner', 'method'], 'back in Inner.method');
  await click(`.editor-group.active-group .nb-crumb[data-name="Outer"] .nb-name`);
  await until(`ide.editor.getPosition().lineNumber === 4`, 'jump to Outer', 5000).catch(() => {});
  check(J(await pos()) === J(['shapes.py', 4, 7]), `clicking Outer jumps to its name (${J(await pos())})`);
  await crumbsAre(['pkg', 'shapes.py', 'Outer'], 'the bar follows the jump');
  await caret(9, 13);
  await crumbsAre(['pkg', 'shapes.py', 'Outer', 'Inner', 'method'], 'caret back in method');
  await click(`.editor-group.active-group .nb-crumb[data-name="method"] .nb-drop`);
  await until(`document.querySelector('.nb-menu')`, 'symbol dropdown');
  check(J(await menuLabels()) === J(['method', 'other']), `method's dropdown lists its siblings in Inner (${J(await menuLabels())})`);
  check(await js(`document.querySelector('.nb-menu .menu-item.nb-current .menu-label')?.textContent === 'method' && !!document.querySelector('.nb-menu .menu-icon .nb-icon.k-method')`), 'the current symbol is marked and rows carry kind icons');
  await clickText('.nb-menu .menu-item', 'other');
  check(J(await pos()) === J(['shapes.py', 12, 13]), `picking a sibling jumps to it (${J(await pos())})`);
  await crumbsAre(['pkg', 'shapes.py', 'Outer', 'Inner', 'other'], 'the bar shows the picked sibling');
  await click(`.editor-group.active-group .nb-crumb[data-name="Outer"] .nb-drop`);
  await until(`document.querySelector('.nb-menu')`, 'top-level dropdown');
  check(J(await menuLabels()) === J(['Outer', 'compute', 'scale', 'offset']), `Outer's dropdown lists the module's classes and functions (${J(await menuLabels())})`);
  await press('Escape');

  // ---- clicking a path segment lists its siblings ----
  await click(`.editor-group.active-group .nb-crumb[data-kind=path]:nth-child(3)`);
  await until(`document.querySelector('.nb-menu')`, 'file dropdown');
  check(J(await menuLabels()) === J(['__init__.py', 'shapes.py']), `shapes.py's dropdown lists the files beside it (${J(await menuLabels())})`);
  check(await js(`document.querySelector('.nb-menu .menu-item.nb-current .menu-label')?.textContent === 'shapes.py' && document.querySelectorAll('.nb-menu .menu-icon .file-icon').length === 2`), 'the current file is marked and rows carry file icons');
  await press('Escape');
  await click(`.editor-group.active-group .nb-crumb[data-kind=path]`);
  await until(`document.querySelector('.nb-menu')`, 'folder dropdown');
  const rootItems = await menuLabels();
  check(rootItems.includes('pkg') && rootItems.includes('app.py') && rootItems.includes('logo.png'), `pkg's dropdown lists the project root (${J(rootItems)})`);
  await clickText('.nb-menu .menu-item', 'app.py');
  await until(`ide.activeTab()?.title === 'app.py'`, 'app.py opened from the dropdown', 5000).catch(() => {});
  check(await js(`ide.activeTab()?.title === 'app.py'`), 'picking a file in the dropdown opens it');
  await crumbsAre(['app.py'], 'app.py at the project root: one path crumb');

  // ---- split editor groups: one bar per group ----
  await openFile(t, 'pkg/shapes.py');
  await caret(9, 13);
  await press('Ctrl+\\');
  await until(`ide.groups().length === 2`, 'split right');
  const [g1, g2] = ['ide.groups()[0]', 'ide.groups()[1]'];
  await js(`(ide.editor.setPosition({ lineNumber: 26, column: 8 }), true)`);
  await crumbsAre(['pkg', 'shapes.py', 'scale'], 'the new group has its own bar following its own caret', g2);
  await crumbsAre(['pkg', 'shapes.py', 'Outer', 'Inner', 'method'], 'the first group keeps its crumbs', g1);
  check(await js(`ide.groups().every(g => g.el.querySelectorAll('.nb-bar').length === 1)`), 'exactly one bar per group');
  await shot('split.png');

  // ---- non-text viewer tabs hide the bar ----
  await openFile(t, 'logo.png');
  await until(`ide.activeTab()?.kind === 'custom'`, 'image viewer tab');
  check(!(await barShown(g2)) && await barShown(g1), 'an image viewer tab hides the bar in its group only');
  await js(`ide.closeTab(ide.activeTab().path)`);
  await until(`ide.activeTab()?.kind === 'file'`, 'back to text');
  await until(`${bar(g2)}.getClientRects().length > 0`, 'bar back', 3000).catch(() => {});
  check(await barShown(g2), 'the bar comes back with the text tab');
  await js(`ide.runAction('UnsplitAll')`);
  await until(`ide.groups().length === 1`, 'unsplit');

  // ---- the setting hides it ----
  check(await js(`ide.settingsPages.some(p => p.id === 'breadcrumbs' && p.group === 'editor' && p.defaults['editor.breadcrumbs'] === true)`), 'Settings › Editor › Breadcrumbs, on by default');
  await js(`(ide.settings.set('editor.breadcrumbs', false), true)`);
  await until(`!${bar()}.getClientRects().length`, 'bar hidden', 3000).catch(() => {});
  check(!(await barShown()), 'turning editor.breadcrumbs off hides the bar');
  const geoOff = await geometry();
  check(geoOff[1] === geo0[1] + 24, `the editor takes the bar's 24px back (${geo0[1]} -> ${geoOff[1]})`);
  await js(`ide.runAction('EditorToggleShowBreadcrumbs')`);
  await until(`${bar()}.getClientRects().length > 0`, 'bar shown', 3000).catch(() => {});
  check(await barShown() && await js(`ide.settings.get('editor.breadcrumbs') === true`), 'Show Breadcrumbs turns it back on');

  // ---- Call Hierarchy: callers from another file, callees, lazy nodes, double-click ----
  await openFile(t, 'pkg/shapes.py');
  await caret(21, 6);
  await press('Ctrl+Alt+H');
  await until(`ide.toolWindows.get('CallHierarchy').isVisible() && document.querySelectorAll('#nbCallTree .nb-ch-row').length >= 3`, 'caller hierarchy', 20000)
    .catch(() => {});
  let rows = await treeRows();
  check(rows[0]?.[0] === 'compute' && rows[0][1] === 0, `Ctrl+Alt+H roots the tree at compute (${J(rows)})`);
  const callers = rows.filter((r) => r[1] === 1);
  check(J(callers.map((r) => r[0])) === J(['main', 'report']) && callers.every((r) => r[2].includes('app.py')), `incoming callers from app.py: main and report (${J(callers)})`);
  check(await js(`document.querySelector('.nb-ch-mode.on')?.dataset.mode === 'callers' && document.querySelector('.nb-ch-head').textContent === 'Callers of compute'`), 'Caller Hierarchy is the default mode, with its header');
  await shot('callers.png');

  // Children load only when a node opens.
  await js(`(() => { window.__chCalls = []; const req = ide.lsp.request; ide.lsp.request = (m, p) => { if (/^callHierarchy\\//.test(m)) window.__chCalls.push(m + ':' + p.item.name); return req(m, p); }; return true; })()`);
  await click(`.nb-ch-mode[data-mode="callees"]`);
  await until(`document.querySelectorAll('#nbCallTree .nb-ch-row[data-depth="1"]').length === 2 && document.querySelector('.nb-ch-head').textContent === 'Callees of compute'`, 'callee hierarchy', 15000).catch(() => {});
  rows = await treeRows();
  check(J(rows.filter((r) => r[1] === 1).map((r) => r[0])) === J(['scale', 'offset']), `Callee Hierarchy lists compute's callees (${J(rows)})`);
  check(J(await js('window.__chCalls')) === J(['callHierarchy/outgoingCalls:compute']), `only the root's calls were requested (${J(await js('window.__chCalls'))})`);
  await click(`#nbCallTree .nb-ch-row[data-name="scale"] .nb-ch-arrow`);
  await until(`window.__chCalls.length === 2`, 'expanding scale', 10000).catch(() => {});
  check(J(await js('window.__chCalls')) === J(['callHierarchy/outgoingCalls:compute', 'callHierarchy/outgoingCalls:scale']), `expanding scale asks for its calls then (${J(await js('window.__chCalls'))})`);
  await dblclickText('#nbCallTree .nb-ch-row', 'offset');
  await until(`ide.editor.getPosition().lineNumber === 22`, 'jump to the offset call', 5000).catch(() => {});
  check(J(await pos()) === J(['shapes.py', 22, 27]), `double-clicking a callee jumps to its call site in compute (${J(await pos())})`);

  await click(`.nb-ch-mode[data-mode="callers"]`);
  await until(`[...document.querySelectorAll('#nbCallTree .nb-ch-row[data-depth="1"]')].map(r => r.dataset.name).join() === 'main,report'`, 'callers again', 15000).catch(() => {});
  await dblclickText('#nbCallTree .nb-ch-row', 'report');
  await until(`ide.activeTab()?.title === 'app.py'`, 'jump to app.py', 5000).catch(() => {});
  check(J(await pos()) === J(['app.py', 9, 11]), `double-clicking a caller jumps to the call in app.py (${J(await pos())})`);
  // A caller's own callers load on expand: main is called from the module's __main__ block.
  await click(`#nbCallTree .nb-ch-row[data-name="main"] .nb-ch-arrow`);
  await until(`document.querySelectorAll('#nbCallTree .nb-ch-row[data-depth="2"]').length >= 1`, 'callers of main', 10000).catch(() => {});
  rows = await treeRows();
  check(rows.some((r) => r[1] === 2) && rows.find((r) => r[1] === 2)[2].includes('app.py'), `expanding main lists its caller in app.py (${J(rows.filter((r) => r[1] === 2))})`);

  // ---- the editor context menu, from a caret inside a function body ----
  await caret(9, 2);
  const at = await js(`(() => { const v = ide.editor.getScrolledVisiblePosition({ lineNumber: 9, column: 2 }); const r = ide.editor.getDomNode().getBoundingClientRect(); return { x: r.left + v.left + 2, y: r.top + v.top + v.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'right', clickCount: 1 });
  const item = await clickMenuPath(t, ['Go To', 'Call Hierarchy']).then(() => true, () => false);
  check(item, 'the editor context menu has Go To › Call Hierarchy');
  if (item) {
    await until(`document.querySelector('#nbCallTree .nb-ch-row[data-depth="0"]')?.dataset.name === 'report'`, 'hierarchy of report', 10000).catch(() => {});
    const rootName = await js(`document.querySelector('#nbCallTree .nb-ch-row[data-depth="0"]')?.dataset.name`);
    check(rootName === 'report', `from inside report() the context menu roots the tree at report (${rootName} at ${J(await pos())}, menu open: ${await js(`!!document.querySelector('.context-menu')`)})`);
  }

  // ---- no layout loops, no exceptions ----
  await sleep(300);
  check(await js('window.__ro') === 0, `no ResizeObserver loop notices (${await js('window.__ro')})`);
  const log = readFileSync(await js(`ide.api.invoke('diagnostics:logFile')`), 'utf8');
  check(!/ResizeObserver loop/.test(log), 'the IDE log has no ResizeObserver loop warning');
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? `: ${t.consoleErrors.join(' | ')}` : ''}`);
} catch (err) {
  check(false, err.message);
}
clearInterval(frames);
t.close();

// ---- Korean ----
const k = await launch({ fixture: 'breadcrumbs', port: 9931, name: 'breadcrumbs-ko', lang: 'ko-KR' });
try {
  await openFile(k, 'pkg/shapes.py');
  await k.until(`ide.lsp.status() === 'ready'`, 'Pyright ready', 40000);
  await k.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 21, column: 6 }), true)`);
  await k.until(`ide.activeGroup().el.querySelectorAll('.nb-bar .nb-crumb').length === 3`, 'Korean breadcrumbs');
  await k.press('Ctrl+Alt+H');
  await k.until(`document.querySelectorAll('#nbCallTree .nb-ch-row').length >= 3`, 'Korean hierarchy', 20000);
  const head = await k.js(`document.querySelector('.nb-ch-head').textContent`);
  k.check(head === 'compute의 호출자' && await k.js(`ide.toolWindows.get('CallHierarchy').tab.textContent.startsWith('계층 구조')`), `Korean header and tool window tab (${head})`);
  const leaks = await englishLeaks(k, '.nb-bar, #bottom .tool.active');
  k.check(leaks.length === 0, `no English UI text in the bar and the Hierarchy window${leaks.length ? ` ${J(leaks)}` : ''}`);
  k.check(await k.js(`ide.actions.find(a => a.id === 'CallHierarchy').title === '호출 계층 구조'`), 'Call Hierarchy action is "호출 계층 구조"');
  await k.shot('ko.png');
  k.check(k.consoleErrors.length === 0, 'no renderer exceptions in Korean');
} catch (err) {
  k.check(false, err.message);
}
k.close();
const all = [...t.results, ...k.results];
const failed = all.filter((r) => !r.ok).length;
console.log(`${all.length - failed}/${all.length} passed`);
process.exit(failed || t.consoleErrors.length || k.consoleErrors.length ? 1 : 0);
