// Type Hierarchy (renderer/features/type-hierarchy, Ctrl+H) in navigation-bar's Hierarchy tool window, against the
// bundled Pyright on verify/fixtures/type-hierarchy: animals/base.py (Named <- Animal, Swimmer, Container[T]),
// animals/pets.py (Dog(Animal), Duck(Animal, Swimmer), Puppy(Dog), Kennel(Container[Dog])) and app.py
// (RubberDuck(Duck)). Supertypes with multiple inheritance and generics, subtypes across files, the class at the caret
// from a usage or from inside a method, navigation, the menus, Call Hierarchy in the same window, Korean. Ports 9032-9033.
import { launch, openFile } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const J = JSON.stringify;
const t = await launch({ fixture: 'type-hierarchy', port: 9032 });
const { js, until, press, click, check, sleep, cdp } = t;
const frames = setInterval(() => cdp('Page.captureScreenshot', { format: 'jpeg', quality: 1 }).catch(() => {}), 80);

const caret = (line, col) => js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${line}, column: ${col} }), true)`);
// Rows as "name@depth", in order.
const rows = () => js(`[...document.querySelectorAll('#nbCallTree .nb-ch-row')].map(r => r.dataset.name + '@' + r.dataset.depth)`);
const rowsAre = async (expected, label, ms = 20000) => {
  try {
    await until(`JSON.stringify([...document.querySelectorAll('#nbCallTree .nb-ch-row')].map(r => r.dataset.name + '@' + r.dataset.depth)) === ${J(J(expected))}`, label, ms);
    check(true, label);
  } catch { check(false, `${label} (got ${J(await rows())})`); }
};
const head = () => js(`document.querySelector('.nb-ch-head')?.textContent`);
const expand = (name) => click(`#nbCallTree .nb-ch-row[data-name="${name}"] .nb-ch-arrow`);
const dblclick = async (name) => {
  const box = await js(`(() => { const r = document.querySelector('#nbCallTree .nb-ch-row[data-name="${name}"]').getBoundingClientRect(); return { x: r.x + r.width / 3, y: r.y + r.height / 2 }; })()`);
  for (const clickCount of [1, 2]) for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount });
  await sleep(60);
};
const where = () => js(`(() => { const p = ide.editor.getPosition(); return [ide.activeTab()?.title, p.lineNumber, p.column]; })()`);

try {
  check(await js(`!!ide.typeHierarchy && ide.actions.some(a => a.id === 'TypeHierarchy' && a.keys.includes('Ctrl+H'))`), 'type-hierarchy plugin loaded, Type Hierarchy on Ctrl+H');
  await openFile(t, 'animals/pets.py');
  await until(`ide.lsp.status() === 'ready'`, 'Pyright ready', 60000);

  // ---- Ctrl+H on a class name: subtypes first (across files) ----
  await caret(9, 8); // class Duck(Animal, Swimmer)
  await press('Ctrl+h');
  await until(`ide.toolWindows.get('CallHierarchy').isVisible() && ide.navigationBar.kind() === 'type'`, 'Hierarchy window with the type hierarchy', 20000);
  await rowsAre(['Duck@0', 'RubberDuck@1'], 'Subtypes of Duck: RubberDuck from app.py');
  check(await head() === 'Subtypes of Duck', `header names the class (${await head()})`);
  check(await js(`[...document.querySelectorAll('.nb-ch-mode')].map(b => b.dataset.mode + (b.classList.contains('on') ? '*' : '')).join()`) === 'supertypes,subtypes*',
    'the toolbar has Supertypes and Subtypes Hierarchy, Subtypes on');
  check(/app\.py:4/.test(await js(`document.querySelector('#nbCallTree .nb-ch-row[data-name="RubberDuck"]').textContent`)), 'the subtype row shows its file and line');

  // ---- supertypes: multiple inheritance in declaration order, then up to object ----
  await click('.nb-ch-mode[data-mode="supertypes"]');
  await rowsAre(['Duck@0', 'Animal@1', 'Swimmer@1'], 'Supertypes of Duck: Animal and Swimmer, in base order');
  check(await head() === 'Supertypes of Duck', `header follows the mode (${await head()})`);
  await expand('Animal');
  await rowsAre(['Duck@0', 'Animal@1', 'Named@2', 'Swimmer@1'], 'Animal expands to Named (in another module)');
  await expand('Named');
  await rowsAre(['Duck@0', 'Animal@1', 'Named@2', 'object@3', 'Swimmer@1'], 'a class without bases derives from object');
  check(await js(`document.querySelector('#nbCallTree .nb-ch-row[data-name="object"] .nb-ch-arrow').textContent === ''`), 'object is a leaf');
  check(/animals\.base/.test(await js(`document.querySelector('#nbCallTree .nb-ch-row[data-name="Named"]').textContent`)), 'rows name the module (animals.base)');

  // ---- navigation: double-click and Enter ----
  await dblclick('Swimmer');
  await until(`ide.activeTab()?.title === 'base.py'`, 'Swimmer opens base.py', 10000).catch(() => {});
  check(J(await where()) === J(['base.py', 15, 7]), `double-click opens the supertype at its name (${J(await where())})`);
  await js(`document.querySelector('#nbCallTree').focus()`);
  await js(`document.querySelector('#nbCallTree .nb-ch-row[data-name="Animal"]').click()`);
  await press('Enter');
  await until(`ide.editor.getPosition().lineNumber === 10`, 'Enter opens Animal', 10000).catch(() => {});
  check(J(await where()) === J(['base.py', 10, 7]), `Enter opens the selected class (${J(await where())})`);

  // ---- subtypes tree: Animal -> Dog -> Puppy, Duck -> RubberDuck ----
  await caret(10, 10); // class Animal(Named) in base.py
  await press('Ctrl+h');
  await until(`ide.navigationBar.kind() === 'type' && document.querySelector('.nb-ch-head')?.textContent === 'Supertypes of Animal'`, 'Animal in the last mode', 15000).catch(() => {});
  check(await head() === 'Supertypes of Animal', `Ctrl+H keeps the last mode (${await head()})`);
  await click('.nb-ch-mode[data-mode="subtypes"]');
  await rowsAre(['Animal@0', 'Dog@1', 'Duck@1'], 'Subtypes of Animal: Dog and Duck from pets.py');
  await expand('Dog');
  await rowsAre(['Animal@0', 'Dog@1', 'Puppy@2', 'Duck@1'], 'Dog expands to Puppy');
  await expand('Duck');
  await rowsAre(['Animal@0', 'Dog@1', 'Puppy@2', 'Duck@1', 'RubberDuck@2'], 'Duck expands to RubberDuck in app.py');

  // ---- generics: Container[T] and Kennel(Container[Dog]) ----
  await caret(20, 8); // class Container(Generic[T])
  await press('Ctrl+h');
  await rowsAre(['Container@0', 'Kennel@1'], 'Subtypes of a generic class: Kennel(Container[Dog])');
  await click('.nb-ch-mode[data-mode="supertypes"]');
  await rowsAre(['Container@0', 'Generic@1'], 'Supertypes of Container: Generic');
  await openFile(t, 'animals/pets.py');
  await caret(17, 8); // class Kennel(Container[Dog])
  await press('Ctrl+h');
  await rowsAre(['Kennel@0', 'Container@1'], 'Supertypes of Kennel: Container, not its type argument Dog');

  // ---- the class at the caret: a usage in another file, or the class around the caret ----
  await openFile(t, 'app.py');
  await caret(10, 12); // Puppy().speak()
  await press('Ctrl+h');
  await rowsAre(['Puppy@0', 'Dog@1'], 'Ctrl+H on a usage shows the class it refers to (Puppy -> Dog)');
  await caret(9, 8); // inside main(): no class -> hint
  await press('Ctrl+h');
  await until(`[...document.querySelectorAll('.monaco-editor-overlaymessage')].some(n => /No type hierarchy/.test(n.textContent))`, 'hint outside a class', 8000)
    .then(() => check(true, 'outside a class Ctrl+H says there is no type hierarchy'), () => check(false, 'outside a class Ctrl+H says there is no type hierarchy'));
  await openFile(t, 'animals/pets.py');
  await caret(6, 12); // return "woof" inside Dog.speak
  await press('Ctrl+h');
  await rowsAre(['Dog@0', 'Animal@1'], 'inside a method, Ctrl+H takes the class around the caret');

  // ---- an edit is seen at once (unsaved text) ----
  await js(`(() => { const m = ide.editor.getModel(); m.pushEditOperations([], [{ range: new ide.monaco.Range(13, 13, 13, 16), text: 'Duck' }], () => null); return m.getLineContent(13); })()`);
  await caret(13, 8); // class Puppy(Duck) now
  await until(`ide.lsp.request('textDocument/hover', { textDocument: { uri: ide.editor.getModel().uri.toString() }, position: { line: 12, character: 13 } }).then(h => /Duck/.test(JSON.stringify(h)))`, 'Pyright sees the edit', 15000).catch(() => {});
  await press('Ctrl+h');
  await rowsAre(['Puppy@0', 'Duck@1'], 'supertypes follow unsaved edits');
  await js(`(ide.editor.trigger('test', 'undo'), true)`);

  // ---- menus and Call Hierarchy in the same window ----
  check(await js(`ide.actions.find(a => a.id === 'TypeHierarchy').title === 'Type Hierarchy'`), 'the action is Type Hierarchy');
  await caret(6, 13);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...(await js(`(() => { const p = ide.editor.getScrolledVisiblePosition({ lineNumber: 6, column: 13 }); const r = ide.editor.getDomNode().getBoundingClientRect(); return { x: r.left + p.left, y: r.top + p.top + 5 }; })()`)), button: 'right', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...(await js(`(() => { const p = ide.editor.getScrolledVisiblePosition({ lineNumber: 6, column: 13 }); const r = ide.editor.getDomNode().getBoundingClientRect(); return { x: r.left + p.left, y: r.top + p.top + 5 }; })()`)), button: 'right', clickCount: 1 });
  const menuItem = `[...document.querySelectorAll('.shadow-root-host')].flatMap(h => [...(h.shadowRoot?.querySelectorAll('.action-label') || [])]).find(n => n.textContent.trim() === 'Type Hierarchy')`;
  await until(`!!${menuItem}`, 'Type Hierarchy in the editor context menu', 8000)
    .then(() => check(true, 'the editor context menu has Type Hierarchy'), () => check(false, 'the editor context menu has Type Hierarchy'));
  await press('Escape');
  await caret(6, 12);
  await press('Ctrl+Alt+H'); // Call Hierarchy of speak in the same window
  await until(`ide.navigationBar.kind() === 'call'`, 'call hierarchy', 15000).catch(() => {});
  check(await js(`[...document.querySelectorAll('.nb-ch-mode')].map(b => b.dataset.mode).join()`) === 'callers,callees' && /^Callers of /.test(await head()),
    `Call Hierarchy takes the window back with its own modes (${await head()})`);
  await caret(4, 8);
  await press('Ctrl+h');
  await until(`ide.navigationBar.kind() === 'type'`, 'type again', 15000).catch(() => {});
  check(await js(`[...document.querySelectorAll('.nb-ch-mode')].map(b => b.dataset.mode).join()`) === 'supertypes,subtypes', 'and Type Hierarchy takes it again');
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? `: ${t.consoleErrors.join(' | ')}` : ''}`);
  await t.shot('type-hierarchy.png');
} catch (err) {
  check(false, err.message);
}
clearInterval(frames);
t.close();

// ---- Korean ----
const k = await launch({ fixture: 'type-hierarchy', port: 9033, name: 'type-hierarchy-ko', lang: 'ko-KR' });
try {
  await openFile(k, 'animals/pets.py');
  await k.until(`ide.lsp.status() === 'ready'`, 'Pyright ready', 60000);
  await k.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 4, column: 8 }), true)`);
  await k.press('Ctrl+h');
  await k.until(`document.querySelectorAll('#nbCallTree .nb-ch-row').length >= 2`, 'Korean type hierarchy', 20000);
  const h = await k.js(`document.querySelector('.nb-ch-head').textContent`);
  k.check(h === 'Dog의 하위 타입', `Korean header (${h})`);
  k.check(await k.js(`[...document.querySelectorAll('.nb-ch-mode')].map(b => b.textContent).join()`) === '상위 타입 계층 구조,하위 타입 계층 구조', 'Korean mode buttons');
  k.check(await k.js(`ide.actions.find(a => a.id === 'TypeHierarchy').title === '타입 계층 구조'`), 'Type Hierarchy action is "타입 계층 구조"');
  const leaks = await englishLeaks(k, '#bottom .tool.active');
  k.check(leaks.length === 0, `no English UI text in the Hierarchy window${leaks.length ? ` ${J(leaks)}` : ''}`);
  const missing = (await missingTranslations(k)).filter((s) => /type hierarchy|Supertypes|Subtypes|Type Hierarchy/i.test(s));
  k.check(missing.length === 0, `every string has a Korean entry${missing.length ? ` ${J(missing)}` : ''}`);
  k.check(k.consoleErrors.length === 0, 'no renderer exceptions in Korean');
} catch (err) {
  k.check(false, err.message);
}
k.close();
const all = [...t.results, ...k.results];
const failed = all.filter((r) => !r.ok).length;
console.log(`${all.length - failed}/${all.length} passed`);
process.exit(failed ? 1 : 0);
