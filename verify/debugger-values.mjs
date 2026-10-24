// Variables pane: Set Value… (F2, inline field), Copy Value (Ctrl+C, the whole value), Copy Name and Add to Watches
// from the row context menu (mouse and the context-menu key), on locals, a dict item, a watch and a global seen from a
// function; the program runs on with the new values. 1008x681 and Korean. Port 9052 (English, then Korean).
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const results = [];

function helpers(t) {
  const { js, until, press, cdp } = t;
  const vars = () => js(`document.querySelector('#dbgVars').textContent`);
  const clipboard = () => js(`ide.api.invoke('clipboard:readText')`);
  const cursorTo = (line) => js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: 1 }))`);
  // Real mouse events on the name of the row with that key in the Variables or Watches tree.
  const mouse = async (rowKey, button = 'left') => {
    const p = await js(`(() => { const r = [...document.querySelectorAll('.dbg-var')].find((n) => n.dataset.key === ${JSON.stringify(rowKey)})?.querySelector('.dbg-name'); if (!r) return null;
      r.scrollIntoView({ block: 'nearest' }); const b = r.getBoundingClientRect(); return { x: b.left + Math.min(b.width / 2, 20), y: b.top + b.height / 2 }; })()`);
    if (!p) throw new Error(`no variable row ${rowKey}`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button, clickCount: 1, buttons: type === 'mousePressed' ? (button === 'left' ? 1 : 2) : 0 });
    }
    await t.sleep(80);
  };
  const menuItem = async (label) => {
    await until(`!!document.querySelector('.context-menu')`, 'context menu');
    const ok = await js(`(() => { const r = [...document.querySelectorAll('.context-menu .menu-item')].find((n) => n.firstChild.textContent === ${JSON.stringify(label)});
      if (!r) return false; r.id = 'dbgTestItem'; return true; })()`);
    if (!ok) throw new Error(`no menu item ${label}`);
    await t.click('#dbgTestItem');
  };
  const setValueTo = async (text) => {
    await until(`document.activeElement?.id === 'dbgSetValue'`, 'Set Value field focused');
    await t.type(text);
    await press('Enter');
  };
  const contextMenuKey = async () => {
    for (const type of ['rawKeyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: 'ContextMenu', code: 'ContextMenu', windowsVirtualKeyCode: 93 });
    await t.sleep(100);
  };
  const start = async () => {
    await openFile(t, 'loop.py');
    await cursorTo(6);
    await press('Ctrl+F8');
    await press('Shift+F9');
    await until(`document.querySelector('#dbgVars').textContent.includes('i = {int} 0')`, 'suspended in the loop', 30000);
  };
  return { vars, clipboard, cursorTo, mouse, menuItem, setValueTo, contextMenuKey, start };
}

const t = await launch({ fixture: 'debugger-values', port: 9052, name: 'debugger-values' });
const { js, until, press, check } = t;
const h = helpers(t);
try {
  await h.start();

  await h.mouse('L/i');
  check(await js(`document.activeElement?.id === 'dbgVars' && document.querySelector('.dbg-var.selected')?.dataset.key === 'L/i'`), 'clicking a variable selects it and gives the list the keyboard');
  await press('F2');
  check(await until(`document.activeElement?.id === 'dbgSetValue' && document.activeElement.value === '0'`, 'Set Value field').catch(() => false),
    'F2 turns the value into a field holding the current value');
  await h.setValueTo('10');
  await until(`document.querySelector('#dbgVars').textContent.includes('i = {int} 10')`, 'i set to 10');
  check(await js(`document.activeElement?.id === 'dbgVars' && document.querySelector('.dbg-var.selected')?.dataset.key === 'L/i'`), 'after Enter the row stays selected and the list keeps the keyboard');
  const inline = `[...(ide.editor.render(true), document).querySelectorAll('#editor .dbg-inline-val')].map((n) => n.textContent.replace(/\\s/g, ' ')).join('|')`;
  check(await until(`${inline}.includes('i: 10')`, 'inline value updated').catch(() => false), `inline values show the new value (${await js(inline)})`);

  await press('F2');
  await h.setValueTo('nosuch_name');
  await until(`document.querySelector('#dbgSetValueError')?.textContent.includes('nosuch_name')`, 'Set Value error');
  check((await js(`document.querySelector('#dbgSetValueError').textContent`)).includes('Cannot set the value:') && await js(`document.activeElement?.id === 'dbgSetValue'`),
    `a value that fails says why and keeps the field (${await js(`document.querySelector('#dbgSetValueError').textContent`)})`);
  await press('Escape');
  check(await js(`!document.querySelector('#dbgSetValue') && document.activeElement?.id === 'dbgVars'`) && (await h.vars()).includes('i = {int} 10'),
    'Esc cancels: the old value stays and the keyboard stays in Variables, not in the editor');

  await press('Ctrl+C');
  await until(`ide.api.invoke('clipboard:readText').then((s) => s === '10')`, 'clipboard 10');
  check(true, 'Ctrl+C copies the selected value');
  await press('ArrowDown');
  await press('ArrowDown');
  check(await js(`document.querySelector('.dbg-var.selected')?.dataset.key`) === 'L/note', 'Up/Down move through the variables');
  const noteRow = `document.querySelector('.dbg-var[data-key="L/note"] .dbg-value').textContent`;
  check((await js(noteRow)).length < 412, `the tree shows debugpy's shortened dict (${(await js(noteRow)).length} characters)`);
  await press('Ctrl+C');
  await until(`ide.api.invoke('clipboard:readText').then((s) => s.length === 412)`, 'whole note on the clipboard');
  check(true, 'Copy Value puts the whole value on the clipboard (a dict with a 400-character string)');
  await press('F2');
  check(await until(`document.querySelector('#dbgSetValue')?.value.length === 412`, 'whole value in the field').catch(() => false),
    'Set Value starts from the whole value, never the shortened text');
  await press('Escape');

  await js(`(() => { const e = ide.editor; e.focus(); e.setSelection(new ide.monaco.Selection(10, 1, 10, 6)); })()`);
  await press('Ctrl+C');
  await until(`ide.api.invoke('clipboard:readText').then((s) => s === 'label')`, 'editor copy');
  await press('F2');
  await t.sleep(300);
  check(!(await js(`!!document.querySelector('#dbgSetValue')`)), 'with a variable selected, Ctrl+C and F2 in the editor keep their editor meaning');

  await h.mouse('L/total', 'right');
  await until(`!!document.querySelector('.context-menu')`, 'context menu');
  const items = await js(`[...document.querySelectorAll('.context-menu .menu-item')].map((n) => n.textContent)`);
  check(items.join('|') === 'Set Value…F2|Copy ValueCtrl+C|Copy Name|Add to Watches', `the row context menu (${items.join('|')})`);
  check(await js(`document.querySelector('.dbg-var.selected')?.dataset.key === 'L/total'`), 'right-click selects the row');
  await h.menuItem('Copy Name');
  await until(`ide.api.invoke('clipboard:readText').then((s) => s === 'total')`, 'clipboard total');
  check(true, 'Copy Name copies the variable name');
  await h.mouse('L/total', 'right');
  await h.menuItem('Add to Watches');
  await until(`document.querySelector('#dbgWatches').textContent.includes('total = {int} 0')`, 'watch added');
  check(true, 'Add to Watches adds the variable as a watch');

  await js(`document.querySelector('#dbgVars').focus()`);
  await h.contextMenuKey();
  await until(`!!document.querySelector('.context-menu')`, 'context menu from the keyboard');
  await press('ArrowDown');
  await press('Enter');
  await h.setValueTo('100');
  await until(`document.querySelector('#dbgVars').textContent.includes('total = {int} 100')`, 'total set to 100');
  check(await js(`document.querySelector('#dbgWatches').textContent.includes('total = {int} 100')`), 'the context-menu key opens the menu for the selected row; Set Value from it updates Variables and Watches');

  await h.mouse('W/total', 'right');
  await h.menuItem('Set Value…');
  await until(`document.activeElement?.id === 'dbgSetValue'`, 'watch field');
  await press('Delete');
  await h.setValueTo('200');
  await until(`document.querySelector('#dbgWatches').textContent.includes('total = {int} 200') && document.querySelector('#dbgVars').textContent.includes('total = {int} 200')`, 'total set to 200 from the watch');
  check(true, 'Set Value on a watch assigns its expression; Delete in its field edits the text and keeps the watch');

  await h.mouse('L/data');
  await until(`[...document.querySelectorAll('.dbg-var')].some((n) => n.dataset.key === "L/data/'k'")`, 'dict item shown');
  await h.mouse(`L/data/'k'`);
  await press('F2');
  await h.setValueTo('5');
  await until(`document.querySelector('#dbgVars').textContent.includes("'k' = {int} 5")`, 'dict item set');
  check(true, 'Set Value on a dict item (its evaluateName) keeps the dict open and shows the new value');

  await t.cdp('Emulation.setDeviceMetricsOverride', { width: 1008, height: 681, deviceScaleFactor: 1, mobile: false });
  await until(`innerWidth === 1008 && Math.abs(innerHeight - 681) <= 1`, 'viewport 1008x681');
  await h.mouse('L/limit', 'right');
  await until(`!!document.querySelector('.context-menu')`, 'context menu (small)');
  check(await js(`(() => { const r = document.querySelector('.context-menu').getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`),
    'at 1008x681 the context menu is inside the window');
  await t.shot('menu-small.png');
  await press('Escape');
  await h.mouse('L/limit');
  await press('F2');
  check(await until(`(() => { const f = document.querySelector('#dbgSetValue'); const r = f?.getBoundingClientRect(); return !!r && r.width >= 80 && r.right <= innerWidth; })()`, 'field fits').catch(() => false),
    'at 1008x681 the Set Value field is wide enough and inside the window');
  await press('Escape');
  await t.cdp('Emulation.clearDeviceMetricsOverride');

  await openFile(t, 'loop.py');
  await h.cursorTo(6);
  await press('Ctrl+F8');
  await press('F9');
  await until(`document.querySelector('#dbgOut').textContent.includes('Process finished with exit code 0')`, 'program finished', 30000);
  check(await js(`document.querySelector('#dbgOut').textContent.includes('sum=(220, 5, 400)')`),
    `the program goes on with the values set while suspended (${(await js(`document.querySelector('#dbgOut').textContent`)).match(/sum=.*/)?.[0]})`);

  await openFile(t, 'gv.py');
  await h.cursorTo(6);
  await press('Ctrl+F8');
  await press('Shift+F9');
  await until(`document.querySelector('#dbgVars').textContent.includes('local = {int} 2')`, 'suspended in bump', 30000);
  const globalRow = `[...document.querySelectorAll('.dbg-var')].find((n) => n.dataset.key === 'S/Globals/counter')`;
  await h.mouse('S/Globals');
  await until(`!!${globalRow}`, 'Globals expanded');
  await h.mouse('S/Globals/counter');
  await press('F2');
  await h.setValueTo('nosuch_name');
  await until(`document.querySelector('#dbgSetValueError')?.textContent.includes('nosuch_name')`, 'Set Value error on a global').catch(() => {});
  check(await js(`(document.querySelector('#dbgSetValueError')?.textContent || '').includes('Cannot set the value:') && document.activeElement?.id === 'dbgSetValue'`),
    `Set Value on a global with a failing value says why and keeps the field (${await js(`document.querySelector('#dbgSetValueError')?.textContent || 'no error shown'`)})`);
  await press('Escape');
  await press('F2');
  await h.setValueTo('99');
  const globalSet = await until(`${globalRow}?.textContent === 'counter = {int} 99'`, 'global set to 99').then(() => true, () => false);
  check(globalSet && !(await js(`[...document.querySelectorAll('.dbg-var')].some((n) => n.dataset.key === 'L/counter')`)),
    `Set Value on a Globals row while stopped in a function sets the global, with no local of that name (${await js(`${globalRow}?.textContent`)})`);
  await press('F9');
  await until(`document.querySelector('#dbgOut').textContent.includes('Process finished')`, 'gv.py finished', 30000);
  const gvOut = await js(`document.querySelector('#dbgOut').textContent`);
  check(gvOut.includes('result 101') && gvOut.includes('counter 99'), `the program sees the global set while suspended (${JSON.stringify(gvOut.match(/result.*|counter \d+/g))})`);
  await openFile(t, 'gv.py');
  await h.cursorTo(6);
  await press('Ctrl+F8');

  // A test file is debugged as its tests (the pytest configuration type's debugTarget), never as a plain script.
  const treeMenu = async (name) => {
    const row = `[...document.querySelectorAll('#tree .node')].find((n) => n._entry.name === ${JSON.stringify(name)})`;
    await until(`!!${row}`, `tree row ${name}`);
    const p = await js(`(() => { const r = ${row}.getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2 }; })()`);
    await t.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    for (const type of ['mousePressed', 'mouseReleased']) await t.cdp('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'right', clickCount: 1, buttons: type === 'mousePressed' ? 2 : 0 });
    await until(`!!document.querySelector('.context-menu .menu-label')`, `menu on ${name}`);
    const labels = await js(`[...document.querySelectorAll('.context-menu .menu-label')].map((l) => l.textContent)`);
    await press('Escape');
    return labels;
  };
  let labels = await treeMenu('test_calc.py');
  const scriptDebug = (l) => l.startsWith("Debug '") && !l.includes('pytest');
  check(!labels.some(scriptDebug) && labels.includes("Debug 'pytest in test_calc.py'"), `a test file's tree menu offers only its tests' Debug entry (${labels.filter((l) => l.startsWith('Debug')).join(' | ')})`);
  labels = await treeMenu('loop.py');
  check(labels.some(scriptDebug), `a plain script keeps its Debug entry (${labels.filter(scriptDebug).join(' | ')})`);
  await openFile(t, 'test_calc.py');
  const firstLine = `document.querySelector('#dbgOut').textContent.split('\\n')[0]`;
  const before = await js(firstLine);
  await t.click('#debugBtn');
  await until(`${firstLine} !== ${JSON.stringify(before)} && !window.__debugger.state()`, 'tests debugged from the toolbar', 60000);
  const first = await js(firstLine);
  check(/debugpy -m pytest |unittest/.test(first), `the toolbar Debug button debugs a test file's tests, not the file as a script (${first})`);

  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${JSON.stringify(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
  await t.shot('failure.png');
}
results.push(...t.results);
t.close();

const k = await launch({ fixture: 'debugger-values', port: 9052, name: 'debugger-values-ko', lang: 'ko-KR' });
try {
  const kh = helpers(k);
  await kh.start();
  await kh.mouse('L/i', 'right');
  await k.until(`!!document.querySelector('.context-menu')`, 'context menu (ko)');
  const items = await k.js(`[...document.querySelectorAll('.context-menu .menu-item')].map((n) => n.firstChild.textContent)`);
  k.check(items.join('|') === '값 설정…|값 복사|이름 복사|감시에 추가', `the context menu in Korean (${items.join('|')})`);
  const leaks = await englishLeaks(k, '.context-menu');
  k.check(leaks.length === 0, `no English in the context menu (${JSON.stringify(leaks)})`);
  await k.shot('menu-ko.png');
  await kh.menuItem('값 설정…');
  await kh.setValueTo('nosuch_name');
  await k.until(`document.querySelector('#dbgSetValueError')?.textContent.includes('nosuch_name')`, 'Set Value error (ko)');
  k.check((await k.js(`document.querySelector('#dbgSetValueError').textContent`)).includes('값을 설정할 수 없습니다:'), 'the Set Value error in Korean');
  await k.press('Escape');
  const missing = await missingTranslations(k);
  k.check(missing.length === 0, `every string has a Korean entry (${JSON.stringify(missing)})`);
  k.check(k.consoleErrors.length === 0, `no renderer exceptions (ko)${k.consoleErrors.length ? ` ${JSON.stringify(k.consoleErrors)}` : ''}`);
} catch (err) {
  k.check(false, err.message);
  await k.shot('failure-ko.png');
}
results.push(...k.results);
k.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
