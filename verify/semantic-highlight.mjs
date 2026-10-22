// Semantic highlighting for Python (renderer/features/semantic-highlight) on verify/fixtures/semantic-highlight:
// token kinds from the sidecar (parameters, self/cls, classes, functions vs methods, properties, modules, constants,
// builtins, decorators, type parameters, imported names), the colors Monaco draws in Dark and Light, a custom color,
// the setting off and on, edits and syntax errors while typing, the interpreter fallback, the Color Scheme page and
// the Korean UI. Ports 9030-9031.
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { launch, openFile, tempDir } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const J = JSON.stringify;

// ---------- pure Node: the sidecar runs isolated (-I) and still resolves names ----------
// A PYTHONPATH folder holds an ast.py that would kill the sidecar if it were imported, and a module the sidecar
// should still read for name resolution; json's dumps comes from typeshed.
let pureFailed = 0;
{
  const require = createRequire(import.meta.url);
  const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
  const cp = require('child_process');
  const realSpawn = cp.spawn;
  const spawned = [];
  cp.spawn = function (cmd, args, ...rest) { spawned.push(args); return realSpawn.call(this, cmd, args, ...rest); };
  const modId = require.resolve(path.join(APP, 'main', 'features', 'semantic-highlight.js'));
  delete require.cache[modId];
  const handlers = {};
  const quit = [];
  require(modId).register({ ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, app: { on: (ev, fn) => quit.push(fn) }, appDir: APP });
  cp.spawn = realSpawn;
  const dir = tempDir('semantic-isolated');
  mkdirSync(path.join(dir, 'shadow'));
  writeFileSync(path.join(dir, 'shadow', 'ast.py'), 'raise SystemExit(7)\n');
  writeFileSync(path.join(dir, 'shadow', 'shadowmod.py'), 'class Foo:\n    pass\n');
  const prevPath = process.env.PYTHONPATH;
  process.env.PYTHONPATH = path.join(dir, 'shadow');
  const text = 'import json\nfrom shadowmod import Foo\nx = Foo()\njson.dumps(x)\n';
  const exe = cp.execFileSync('py', ['-3', '-I', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
  const r = await handlers['semantic-highlight:tokens'](null, [{ cmd: exe, args: [], executable: exe }], { text, path: path.join(dir, 'm.py'), root: dir });
  if (prevPath === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = prevPath;
  await handlers['semantic-highlight:stop']();
  const TYPES = ['namespace', 'class', 'typeParameter', 'parameter', 'selfParameter', 'clsParameter', 'variable', 'property', 'function', 'method', 'decorator'];
  const toks = [];
  let line = 0;
  let col = 0;
  const data = r.result?.data || [];
  for (let i = 0; i < data.length; i += 5) {
    line += data[i];
    col = data[i] ? data[i + 1] : col + data[i + 1];
    toks.push(`${text.split('\n')[line].slice(col, col + data[i + 2])}@${line + 1}:${TYPES[data[i + 3]]}`);
  }
  const ok = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`); if (!cond) pureFailed++; };
  const sidecars = spawned.filter((a) => a.some((x) => /semantic_server\.py$/.test(x)));
  ok(sidecars.length && sidecars.every((a) => a.includes('-I') && a.includes('utf8') && a.includes('-B')), `the sidecar is started with -I -X utf8 -B (${J(sidecars[0]?.slice(0, 5))})`);
  ok(!r.error && toks.includes('Foo@3:class') && toks.includes('json@4:namespace') && toks.includes('dumps@4:function'),
    `isolated, it ignores an ast.py on PYTHONPATH, still reads modules there and typeshed's stubs (${r.error ? J(r.error) : toks.join(' ')})`);
}

const DARK = { parameter: '#e6c07b', self: '#94558d', class: '#2fbaa3', typeParameter: '#a3be8c', function: '#56a8f5', method: '#57aaf7',
  property: '#c77dbb', module: '#8da4c8', constant: '#c77dbb', builtin: '#8888c6', decorator: '#b3ae60', plain: '#bcbec4' };
const LIGHT = { parameter: '#a0522d', self: '#94558d', class: '#0e7c7b', function: '#00627a', builtin: '#000080', plain: '#080808' };

const t = await launch({ fixture: 'semantic-highlight', port: 9030 });
const { js, until, check, type, sleep, cdp } = t;
// Monaco draws only while frames are produced; the window may sit behind others on the test desktop.
const frames = setInterval(() => cdp('Page.captureScreenshot', { format: 'jpeg', quality: 1 }).catch(() => {}), 80);

// The color Monaco drew for the text starting at (line, col), 1-based; reveals the line first.
await js(`(window.__colorAt = (line, col) => {
  const ed = ide.editor;
  ed.revealLineInCenterIfOutsideViewport(line);
  const p = ed.getScrolledVisiblePosition({ lineNumber: line, column: col });
  if (!p) return null;
  const box = ed.getDomNode().getBoundingClientRect();
  const span = document.elementsFromPoint(box.left + p.left + 2, box.top + p.top + p.height / 2)
    .find((n) => n.tagName === 'SPAN' && n.closest('.view-line'));
  if (!span) return null;
  const m = getComputedStyle(span).color.match(/\\d+/g).map(Number);
  return '#' + m.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');
}, true)`);
// Enter as a keyboard types it (keydown, the char, keyup), so Monaco's own Enter handling runs; Escape first closes a
// suggestion list that would take the Enter.
const enter = async () => {
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdp('Input.dispatchKeyEvent', { type: 'char', text: '\r', key: 'Enter' });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(40);
};
const colorAt = (line, col) => js(`window.__colorAt(${line}, ${col})`);
const colorIs = async (line, col, hex, label, ms = 15000) => {
  try {
    await until(`window.__colorAt(${line}, ${col}) === ${J(hex)}`, label, ms);
    check(true, label);
  } catch { check(false, `${label} (drawn ${await colorAt(line, col)}, expected ${hex})`); }
};

try {
  check(await js(`!!ide.semanticHighlight && ide.semanticHighlight.enabled()`), 'semantic-highlight plugin loaded, on by default');
  await js(`ide.settings.set('appearance.theme', 'dark')`); // new profiles follow the OS theme
  await openFile(t, 'shapes.py');
  await until(`ide.interps.length > 0`, 'interpreters listed', 30000);

  // ---- token kinds from the sidecar ----
  const toks = await js(`ide.semanticHighlight.tokens(ide.editor.getModel())`);
  const at = (line, text, n = 0) => toks.filter((x) => x.line === line && x.text === text)[n];
  const kind = (line, text, n) => { const x = at(line, text, n); return x ? [x.type, ...x.mods].join('.') : 'none'; };
  const expect = [
    [2, 'os', 'namespace'], [3, 'dataclasses', 'namespace'], [3, 'dataclass', 'function'], [4, 'Generic', 'class'], [4, 'TypeVar', 'class'],
    [6, 'T', 'typeParameter'], [7, 'MAX_SIZE', 'variable.readonly'],
    [10, 'decorate', 'function.declaration'], [10, 'fn', 'parameter.declaration'], [11, 'fn', 'parameter'],
    [14, '@', 'decorator'], [14, 'dataclass', 'decorator'], [15, 'Point', 'class.declaration'], [16, 'x', 'property'], [16, 'int', 'class.defaultLibrary'],
    [19, 'property', 'decorator'], [20, 'norm', 'property.declaration'], [20, 'self', 'selfParameter.declaration'], [20, 'float', 'class.defaultLibrary'],
    [21, 'self', 'selfParameter'], [21, 'x', 'property'],
    [23, 'classmethod', 'decorator'], [24, 'origin', 'method.declaration'], [24, 'cls', 'clsParameter.declaration'], [25, 'cls', 'clsParameter'],
    [27, 'moved', 'method.declaration'], [27, 'dx', 'parameter.declaration'], [28, 'Point', 'class'], [28, 'dx', 'parameter'],
    [31, 'Box', 'class.declaration'], [31, 'Generic', 'class'], [31, 'T', 'typeParameter'], [33, 'item', 'property'],
    [36, 'first', 'function.declaration'], [36, 'U', 'typeParameter.declaration'], [36, 'list', 'class.defaultLibrary'], [37, 'items', 'parameter'],
    [40, 'area', 'function.declaration'], [41, 'width', 'parameter'], [42, 'print', 'function.defaultLibrary'], [42, 'len', 'function.defaultLibrary'],
    [42, 'os', 'namespace'], [42, 'MAX_SIZE', 'variable.readonly'],
    [46, 'decorate', 'decorator'], [47, 'main', 'function.declaration'],
    [48, 'Point', 'class'], [48, 'origin', 'method'], [49, 'norm', 'property'], [49, 'moved', 'method'], [49, 'area', 'function'], [49, 'Box', 'class'],
  ];
  const wrong = expect.filter(([l, x, k]) => kind(l, x) !== k).map(([l, x, k]) => `${l}:${x} ${kind(l, x)} (expected ${k})`);
  check(!wrong.length, `every name has its kind (${expect.length} checked)${wrong.length ? `: ${wrong.join('; ')}` : ''}`);
  check(kind(24, 'Point') === 'class', `a forward reference "Point" in an annotation is a class (${kind(24, 'Point')})`);
  check(!at(41, 'total') || kind(41, 'total') === 'variable', 'a local variable stays a plain variable');

  // ---- colors drawn in Dark ----
  await colorIs(20, 14, DARK.self, 'Dark: self is drawn in the self parameter color');
  await colorIs(10, 14, DARK.parameter, 'Dark: a parameter has the parameter color');
  await colorIs(15, 7, DARK.class, 'Dark: a class name has the class color');
  await colorIs(24, 9, DARK.method, 'Dark: a method declaration has the method color');
  await colorIs(10, 5, DARK.function, 'Dark: a function declaration has the function color');
  await colorIs(49, 13, DARK.property, 'Dark: a property access has the property color');
  await colorIs(2, 8, DARK.module, 'Dark: a module has the module color');
  await colorIs(7, 1, DARK.constant, 'Dark: a constant has the constant color');
  await colorIs(42, 5, DARK.builtin, 'Dark: a builtin has the builtin color');
  await colorIs(14, 2, DARK.decorator, 'Dark: a decorator has the decorator color');
  await colorIs(36, 11, DARK.typeParameter, 'Dark: a type parameter has the type parameter color');

  // ---- Light ----
  await js(`ide.settings.set('appearance.theme', 'light')`);
  await colorIs(20, 14, LIGHT.self, 'Light: self parameter color');
  await colorIs(10, 14, LIGHT.parameter, 'Light: parameter color');
  await colorIs(15, 7, LIGHT.class, 'Light: class color');
  await colorIs(42, 5, LIGHT.builtin, 'Light: builtin color');
  await js(`ide.settings.set('appearance.theme', 'dark')`);
  await colorIs(15, 7, DARK.class, 'back to Dark: class color');

  // ---- a custom color from the setting ----
  await js(`ide.settings.set('editor.colorScheme.python', { dark: { class: '#ff0000' } })`);
  await colorIs(15, 7, '#ff0000', 'a custom class color applies at once');
  await colorIs(20, 14, DARK.self, 'other kinds keep their default colors');
  await js(`ide.settings.set('editor.colorScheme.python', null)`);
  await colorIs(15, 7, DARK.class, 'Restore Defaults brings the class color back');

  // ---- setting off and on ----
  await js(`ide.settings.set('editor.semanticHighlighting', false)`);
  await colorIs(10, 14, DARK.plain, 'off: a parameter is plain text again');
  await colorIs(20, 14, DARK.self, 'off: self keeps the syntax color');
  await colorIs(2, 8, DARK.plain, 'off: a module name is plain text');
  const before = await js(`ide.semanticHighlight.stats().requests`);
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ide.editor.getModel().getLineCount(), column: 1 }), true)`);
  await enter();
  await type('x = 1');
  await sleep(1500);
  check(await js(`ide.semanticHighlight.stats().requests`) === before, 'off: edits ask for no tokens');
  await js(`ide.settings.set('editor.semanticHighlighting', true)`);
  await colorIs(10, 14, DARK.parameter, 'on again: the parameter color is back');

  // ---- edits while typing ----
  const lines = await js(`ide.editor.getModel().getLineCount()`);
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: ${lines}, column: ide.editor.getModel().getLineMaxColumn(${lines}) }), true)`);
  await enter();
  await enter();
  await type('def scale(factor: float) -> float:');
  await enter();
  // Monaco may or may not indent after the colon; the body line ends up indented either way.
  const indent = await js(`ide.editor.getModel().getLineContent(ide.editor.getPosition().lineNumber).length`);
  await type(`${' '.repeat(Math.max(0, 4 - indent))}return factor * MAX_SIZE`);
  const L = lines + 2;
  const col = (line, word) => js(`ide.editor.getModel().getLineContent(${line}).indexOf(${J(word)}) + 1`);
  check(await js(`ide.editor.getModel().getLineContent(${L})`) === 'def scale(factor: float) -> float:', 'the new function is on its line');
  await colorIs(L, 5, DARK.function, 'a function typed just now is colored after the pause');
  await colorIs(L + 1, await col(L + 1, 'factor'), DARK.parameter, 'its parameter use is colored');
  await colorIs(L + 1, await col(L + 1, 'MAX_SIZE'), DARK.constant, 'a constant use is colored');
  // A syntax error while typing keeps the colors (the sidecar cannot parse the file, Monaco keeps the last tokens).
  await enter();
  await type('def broken(:');
  const reqs = await js(`ide.semanticHighlight.stats().errors`);
  await until(`ide.semanticHighlight.stats().errors > ${reqs}`, 'a request for the broken text', 10000).catch(() => {});
  await sleep(500);
  check(await colorAt(20, 14) === DARK.self && await colorAt(10, 14) === DARK.parameter, 'a syntax error keeps the colors on screen');
  await js(`(() => { const m = ide.editor.getModel(); let l = m.getLineCount(); while (l > 1 && !m.getLineContent(l).includes('def broken(:')) l--;
    m.pushEditOperations([], [{ range: new ide.monaco.Range(l, 1, l, m.getLineMaxColumn(l)), text: '' }], () => null); return true; })()`);
  await colorIs(20, 14, DARK.self, 'fixing the syntax error keeps the colors');

  // ---- interpreter fallback in the main process ----
  const params = `{ text: 'import os\\nprint(os.sep)\\n', path: '', root: '' }`;
  const real = `(() => { const i = ide.currentInterp(); return { cmd: i.cmd, args: i.args || [], executable: i.executable }; })()`;
  const fb = await js(`ide.api.invoke('semantic-highlight:tokens', [{ cmd: 'C:\\\\nowhere\\\\python.exe', args: [], executable: 'C:\\\\nowhere\\\\python.exe' }, ${real}], ${params})`);
  check(Array.isArray(fb?.result?.data) && fb.result.data.length === 20, `an interpreter that cannot start is skipped for the next one (${J(fb).slice(0, 120)})`);
  const none = await js(`ide.api.invoke('semantic-highlight:tokens', [{ cmd: 'C:\\\\nowhere\\\\python.exe', args: [], executable: 'C:\\\\nowhere\\\\python.exe' }], ${params})`);
  check(none?.error?.code === 'no-python', `no usable interpreter answers no-python (${J(none)})`);
  await js(`ide.api.invoke('semantic-highlight:reset')`);
  await js(`ide.semanticHighlight.tokens(ide.editor.getModel())`);
  check((await js(`ide.semanticHighlight.stats().lastMs`)) < 3000, `tokens for the fixture answer quickly (${await js(`ide.semanticHighlight.stats().lastMs`)} ms)`);

  // ---- Settings › Editor › Color Scheme ----
  await js(`ide.openSettings('color-scheme')`);
  await until(`document.querySelector('.settings-page')?.dataset.page === 'color-scheme'`, 'Color Scheme page');
  check(await js(`document.querySelectorAll('.sh-color').length === 22 && !!document.querySelector('[data-key="editor.semanticHighlighting"]')?.checked`), 'the page lists Dark and Light colors for 11 kinds and the switch is on');
  check(await js(`document.querySelector('.sh-color[data-theme="dark"][data-kind="parameter"]').value === '${DARK.parameter}'`), 'the color inputs show the default colors');
  await js(`(() => { const c = document.querySelector('[data-key="editor.semanticHighlighting"]'); c.click(); return true; })()`);
  await js(`(() => { const i = document.querySelector('.sh-color[data-theme="dark"][data-kind="module"]'); i.value = '#123456'; i.dispatchEvent(new Event('input')); return true; })()`);
  await js(`document.querySelector('#settingsOk, .dialog .primary')?.click()`);
  await until(`ide.settings.get('editor.semanticHighlighting') === false && ide.settings.get('editor.colorScheme.python')?.dark?.module === '#123456'`, 'OK applies the switch and the color', 5000)
    .then(() => check(true, 'OK applies the switch and the color'), () => check(false, 'OK applies the switch and the color'));
  await js(`(ide.settings.set('editor.semanticHighlighting', true), ide.settings.set('editor.colorScheme.python', null), true)`);
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? `: ${t.consoleErrors.join(' | ')}` : ''}`);
  await t.shot('dark.png');
} catch (err) {
  check(false, err.message);
}
clearInterval(frames);
t.close();

// ---- Korean ----
const k = await launch({ fixture: 'semantic-highlight', port: 9031, name: 'semantic-highlight-ko', lang: 'ko-KR' });
try {
  await k.js(`ide.openSettings('color-scheme')`);
  await k.until(`document.querySelector('.settings-page')?.dataset.page === 'color-scheme'`, 'Korean Color Scheme page');
  const title = await k.js(`document.querySelector('.settings-crumb')?.textContent || ''`);
  k.check(/색 구성표/.test(title), `the page is 색 구성표 (${title})`);
  const leaks = await englishLeaks(k, '.settings-page');
  k.check(leaks.length === 0, `no English UI text on the page${leaks.length ? ` ${J(leaks)}` : ''}`);
  const missing = (await missingTranslations(k)).filter((s) => /Semantic|Color Scheme|parameter|Parameter|Module|Constant|Builtin|Decorator|Property|Method|Function|Class|Restore Defaults|Colors names/.test(s));
  k.check(missing.length === 0, `every string has a Korean entry${missing.length ? ` ${J(missing)}` : ''}`);
  k.check(k.consoleErrors.length === 0, 'no renderer exceptions in Korean');
} catch (err) {
  k.check(false, err.message);
}
k.close();
const all = [...t.results, ...k.results];
const failed = all.filter((r) => !r.ok).length + pureFailed;
console.log(`${all.length - failed + pureFailed}/${all.length} passed${pureFailed ? `, ${pureFailed} pure Node check(s) failed` : ''}`);
process.exit(failed ? 1 : 0);
