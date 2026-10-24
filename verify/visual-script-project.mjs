// Visual Scripting with the project's own functions and installed packages (renderer/features/visual-script/symbols.js,
// python/vs_symbols.py, main/features/visual-script.js, the py.function / py.new / py.method nodes). Ports 9086-9087.
// The palette lists the fixture's modules (ast only; node_modules, virtual environments, hidden folders and files over
// 1 MB left out); a graph built from palette picks runs with real output (keyword and optional arguments, *args and
// **kwargs, a class and its methods, a dataclass, an async function, two modules with the same function name); math,
// random and json through a dotted search and Browse Package…; main refuses to import a project module; editing a
// function's signature and saving shows "parameters changed" and Update rewires; a removed function is a problem that
// stops the run, one in a file the index skipped as too large is not; Korean; and Safe Mode lists and loads nothing.
// `--viewport=1008x681` gives the window the inner size it has on CI's 1024x768 screen.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const S = JSON.stringify;
const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const viewport = process.argv.find((a) => a.startsWith('--viewport='))?.slice(11).split('x').map(Number);
async function sized(ctx) {
  if (!viewport) return ctx;
  await ctx.cdp('Emulation.setDeviceMetricsOverride', { width: viewport[0], height: viewport[1], deviceScaleFactor: 1, mobile: false });
  await ctx.until(`Math.abs(innerWidth - ${viewport[0]}) <= 1 && Math.abs(innerHeight - ${viewport[1]}) <= 1`, 'the emulated viewport');
  return ctx;
}

const BUTTONS = { left: 1, right: 2, middle: 4 };
function inputs(ctx) {
  const { cdp, sleep, js } = ctx;
  const mouse = (type, p, { button = 'left', clickCount = 1, pressed = button } = {}) => cdp('Input.dispatchMouseEvent', {
    type, x: p.x, y: p.y, button: type === 'mouseMoved' && !pressed ? 'none' : button, buttons: type === 'mouseReleased' || !pressed ? 0 : BUTTONS[button], clickCount,
  });
  const move = async (p) => { await mouse('mouseMoved', p, { pressed: null }); await sleep(60); };
  async function click(p, opts = {}) {
    await move(p);
    await mouse('mousePressed', p, opts);
    await mouse('mouseReleased', p, opts);
    await sleep(100);
  }
  const center = (selector) => js(`(() => { const n = document.querySelector(${S(selector)}); if (!n) return null; const list = n.closest('.vs-pal-list'); if (list) list.scrollTop = n.offsetTop - list.clientHeight / 2; const r = n.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
  async function clickOn(selector, opts) {
    const p = await center(selector);
    if (!p) throw new Error(`nothing to click: ${selector}`);
    await click(p, opts);
  }
  const emptySpot = () => js(`(() => { const c = document.querySelector('.vs-host:not(.hidden) .vs-canvas').getBoundingClientRect();
    for (let y = c.bottom - 30; y > c.top + 30; y -= 20) for (let x = c.left + 30; x < c.right - 30; x += 20) {
      const t = document.elementFromPoint(x, y);
      if (t && (t.classList.contains('vs-canvas') || t.classList.contains('vs-nodes')) && !document.elementsFromPoint(x, y).some((e) => e.closest?.('.vs-node, .vs-palette'))) return { x, y };
    }
    return null; })()`);
  return { mouse, move, click, clickOn, center, emptySpot };
}

const V = 'ide.activeTab().visualScript';
const VSJ = 'window.PyideVisualScript';
const HOST = '.vs-host:not(.hidden)';
const runText = `(document.querySelector('#runOut')?.textContent || '')`;
const programOutput = `[...document.querySelectorAll('#runOut > span')].filter((s) => !s.classList.contains('cmd') && !s.classList.contains('sys')).map((s) => s.textContent).join('').replace(/\\r\\n/g, '\\n')`;
const row = (module, name) => `${HOST} .vs-palette .vs-pal-item[data-module=${S(module)}][data-name=${S(name)}]`;

async function openScript(ctx, name) {
  await ctx.js(`ide.openFile(ide.util.joinPath(ide.root, ${S(name)}))`);
  await ctx.until(`ide.activeTab()?.path.toLowerCase().endsWith(${S(`\\${name}`.toLowerCase())}) && !!${V}?.graph() && !!document.querySelector('${HOST} .vs-node')`, `${name} on the canvas`);
}
async function focusCanvas(ctx, ui) {
  await ui.click(await ui.emptySpot());
  await ctx.until(`document.activeElement?.classList.contains('vs-canvas')`, 'the canvas has the keyboard');
}
async function openPalette(ctx, ui) {
  await focusCanvas(ctx, ui);
  await ctx.press('Tab');
  await ctx.until(`document.activeElement?.classList.contains('vs-pal-input')`, 'the palette is open');
}
// Types a search and picks the entry for module.name with the keyboard; returns the new node's id.
async function addFromPalette(ctx, ui, query, module, name) {
  await openPalette(ctx, ui);
  const before = await ctx.js(`${V}.graph().nodes.map((n) => n.id)`);
  await ctx.type(query);
  await ctx.until(`!!document.querySelector(${S(row(module, name))})`, `${module} ${name} in the palette for "${query}"`, 30000);
  const index = await ctx.js(`[...document.querySelectorAll('${HOST} .vs-palette .vs-pal-item')].findIndex((r) => r.matches(${S(row(module, name))}))`);
  for (let i = 0; i < index; i++) await ctx.press('ArrowDown');
  await ctx.press('Enter');
  await ctx.until(`${V}.graph().nodes.length === ${before.length + 1}`, `${name} added`);
  return ctx.js(`${V}.graph().nodes.find((n) => !${S(before)}.includes(n.id)).id`);
}
// Wires and literals through the document (an external edit the canvas follows): steps [[from, pin, to, pin] |
// [node, pin, literal]].
async function wire(ctx, steps) {
  await ctx.js(`(() => {
    const VS = ${VSJ};
    let g = ${V}.graph();
    for (const s of ${S(steps)}) {
      if (s.length === 4) { const next = VS.connect(g, { node: s[0], pin: s[1] }, { node: s[2], pin: s[3] }); if (next === g) throw new Error('refused ' + s.join(' ') + ': ' + VS.lastError); g = next; }
      else g = VS.setInputLiteral(g, s[0], s[1], s[2]);
    }
    ide.getDocument(ide.activeTab().path).model.setValue(VS.serialize(g));
    return true;
  })()`);
  await ctx.until(`${V}.graph().links.length >= ${steps.filter((s) => s.length === 4).length}`, 'the wires are on the canvas');
}
async function addPlain(ctx, type, extra = {}) {
  return ctx.js(`(() => {
    const VS = ${VSJ};
    const g = ${V}.graph();
    const id = VS.nextId(g);
    ide.getDocument(ide.activeTab().path).model.setValue(VS.serialize(VS.addNode(g, { id, type: ${S(type)}, x: 0, y: 600, ...${S(extra)} })));
    return id;
  })()`);
}
async function run(ctx, ui) {
  await ctx.js(`ide.saveTab(ide.activeTab())`);
  await focusCanvas(ctx, ui);
  await ctx.press('Shift+F10');
  await ctx.until(`/Process finished with exit code \\d+|종료 코드 \\d+|Fix the problems/.test(${runText})`, 'the run ends', 60000);
  return ctx.js(programOutput);
}

// ===================================================================== A: English, trusted
const ctx = await sized(await launch({ fixture: 'visual-script-project', port: 9086, name: 'visual-script-project' }));
const { js, until, press, type, check, sleep, project } = ctx;
const ui = inputs(ctx);
try {
  const interp = await js(`(() => { const i = ide.currentInterp(); return i && { cmd: i.cmd, args: i.args || [] }; })()`);
  check(!!interp, `a Python interpreter is selected (${interp?.cmd})`);
  const py = (code) => spawnSync(interp.cmd, [...interp.args, '-I', '-X', 'utf8', '-c', code], { encoding: 'utf8' }).stdout.replace(/\r\n/g, '\n');

  // Files the index must leave out, made before the project is read.
  mkdirSync(path.join(project, 'localenv', 'Lib'), { recursive: true });
  writeFileSync(path.join(project, 'localenv', 'pyvenv.cfg'), 'home = C:\\nowhere\n');
  writeFileSync(path.join(project, 'localenv', 'Lib', 'envmod.py'), 'def in_venv():\n    pass\n');
  mkdirSync(path.join(project, '.hidden'));
  writeFileSync(path.join(project, '.hidden', 'secret.py'), 'def hidden():\n    pass\n');
  writeFileSync(path.join(project, 'big.py'), `def big():\n    pass\n${'# padding\n'.repeat(120000)}`);
  writeFileSync(path.join(project, 'geo', 'huge.py'), `def huge():\n    pass\n${'# padding\n'.repeat(120000)}`);

  await openScript(ctx, 'calls.pyflow');
  await until(`${VSJ}.symbols.ready() && ${VSJ}.symbols.project().length >= 6`, 'the project index is read', 30000);
  const mods = await js(`${VSJ}.symbols.project().map((m) => m.name)`);
  check(S(mods) === S(['geo', 'geo.figures', 'geo.points', 'helpers', 'tests.test_geo', 'tools.text']), `the index has the project's modules, tests included, and nothing from node_modules, a virtual environment, a hidden folder or a file over 1 MB (${S(mods)})`);
  const fig = await js(`${VSJ}.symbols.project().find((m) => m.name === 'geo.figures')`);
  const fn = (name) => fig.functions.find((f) => f.name === name);
  check(S(fn('perimeter').params) === S([
    { name: 'w', kind: 'positional', default: null, annotation: 'float' },
    { name: 'h', kind: 'positional', default: '1', annotation: 'float' },
    { name: 'double', kind: 'keyword-only', default: 'False', annotation: 'bool' },
  ]) && fn('perimeter').returns === 'float' && fn('perimeter').doc === 'Perimeter of a w by h rectangle.', `parameters carry kind, default and annotation as source text (${S(fn('perimeter'))})`);
  check(fn('total').params[0].kind === 'var-positional' && fn('describe').params[0].kind === 'var-keyword' && fn('slow_square').async === true, '*args, **kwargs and async functions are recognised');
  const rect = fig.classes.find((c) => c.name === 'Rect');
  check(S(rect.params.map((p) => p.name)) === S(['w', 'h']) && S(rect.methods.map((m) => [m.name, m.kind])) === S([['area', 'method'], ['unit', 'static'], ['square', 'class']]),
    `a class has its __init__ parameters without self and its public methods with their kinds, no property or _private (${S(rect.methods.map((m) => m.name))})`);
  const point = (await js(`${VSJ}.symbols.project().find((m) => m.name === 'geo.points')`)).classes[0];
  check(S(point.params) === S([{ name: 'x', kind: 'positional', default: null, annotation: 'float' }, { name: 'y', kind: 'positional', default: '0', annotation: 'float' }]), 'a dataclass gets its fields as constructor parameters');

  // ---- the palette ----
  await openPalette(ctx, ui);
  const cats = await js(`[...document.querySelectorAll('${HOST} .vs-palette .vs-pal-cat')].map((h) => h.textContent.replace('▾', ''))`);
  check(cats.includes('Project') && cats.includes('Packages') && cats.includes('geo.figures') && cats.indexOf('geo.figures') > cats.indexOf('Project'), `the palette has Project with one branch per module, and Packages (${S(cats)})`);
  const tip = await js(`document.querySelector(${S(row('geo.figures', 'area'))})?.title`);
  check(tip === 'area(r: float) -> float\nArea of a circle with radius r, rounded to 2 places.', `an entry's tooltip is its signature and docstring line (${S(tip)})`);
  check(await js(`!!document.querySelector(${S(row('geo.figures', 'New Rect'))}) && !!document.querySelector(${S(row('geo.figures', 'Rect.square'))}) && !document.querySelector('${HOST} .vs-pal-item[data-type="py.function"]:not([data-module])')`), 'classes are offered as New Rect and methods as Rect.square');
  await press('Escape');

  const nPer = await addFromPalette(ctx, ui, 'perim', 'geo.figures', 'perimeter');
  const per = await js(`${V}.graph().nodes.find((n) => n.id === ${S(nPer)})`);
  check(per.type === 'py.function' && per.props.module === 'geo.figures' && per.props.name === 'perimeter' && per.props.returns === 'float' && per.props.params.length === 3,
    `typing "perim" and Enter adds a Python Function node with the signature stored in it (${S(per.props)})`);
  const look = await js(`(() => { const n = document.querySelector('${HOST} .vs-node[data-id=${S(nPer)}]'); return { title: n.querySelector('.vs-title').textContent, pins: [...n.querySelectorAll('.vs-pin-in.vs-data')].map((p) => p.dataset.pin), hph: n.querySelector('.vs-pin[data-pin="h"]').parentElement.querySelector('.vs-field')?.placeholder, head: n.querySelector('.vs-head').title }; })()`);
  check(look.title === 'perimeter geo.figures' && S(look.pins) === S(['w', 'h', 'double']) && look.hph === '1' && look.head.startsWith('geo.figures.perimeter\nperimeter(w: float, h: float = 1, *, double: bool = False) -> float'),
    `the node is titled with the function and its module, has one input per parameter, shows a default as the field's placeholder and the signature on its header (${S(look)})`);

  const nArea = await addFromPalette(ctx, ui, 'area', 'geo.figures', 'area');
  const nArea2 = await addFromPalette(ctx, ui, 'area', 'tools.text', 'area');
  const nRect = await addFromPalette(ctx, ui, 'new rect', 'geo.figures', 'New Rect');
  const nRectArea = await addFromPalette(ctx, ui, 'rect.area', 'geo.figures', 'Rect.area');
  const nSquare = await addFromPalette(ctx, ui, 'square', 'geo.figures', 'Rect.square');
  const nPoint = await addFromPalette(ctx, ui, 'new point', 'geo.points', 'New Point');
  const nDist = await addFromPalette(ctx, ui, 'dist', 'geo.points', 'Point.dist');
  const nSlow = await addFromPalette(ctx, ui, 'slow', 'geo.figures', 'slow_square');
  const nTotal = await addFromPalette(ctx, ui, 'total', 'geo.figures', 'total');
  const nDescribe = await addFromPalette(ctx, ui, 'describe', 'geo.figures', 'describe');
  const nGreet = await addFromPalette(ctx, ui, 'greet', 'helpers', 'greet');
  const nKo = await addFromPalette(ctx, ui, '인사', 'helpers', '인사');
  const prints = [];
  for (let i = 0; i < 10; i++) prints.push(await addPlain(ctx, 'io.print'));
  const nList = await addPlain(ctx, 'value.list', { props: { count: 3 }, inputs: { item0: 1, item1: 2, item2: 3 } });
  const nDict = await addPlain(ctx, 'py.expr', { props: { code: "{'b': 2, 'a': 1}", inputs: '' } });
  const chain = ['n1', nPer, prints[0], nArea, prints[1], nArea2, prints[2], nRect, nRectArea, prints[3], nSquare, nPoint, nDist, prints[4], nSlow, prints[5], nTotal, prints[6], nDescribe, prints[7], nGreet, prints[8], nKo, prints[9]];
  const steps = [];
  for (let i = 0; i + 1 < chain.length; i++) steps.push([chain[i], 'next', chain[i + 1], 'in']);
  steps.push(
    [nPer, 'w', 3], [nPer, 'double', true], [nPer, 'result', prints[0], 'value'],
    [nArea, 'r', 2], [nArea, 'result', prints[1], 'value'],
    [nArea2, 'w', 2], [nArea2, 'h', 3], [nArea2, 'result', prints[2], 'value'],
    [nRect, 'w', 2], [nRect, 'h', 3], [nRect, 'object', nRectArea, 'object'], [nRectArea, 'result', prints[3], 'value'],
    [nSquare, 'side', 4], [nPoint, 'x', 3], [nPoint, 'y', 4], [nPoint, 'object', nDist, 'object'], [nDist, 'result', prints[4], 'value'],
    [nSlow, 'x', 5], [nSlow, 'result', prints[5], 'value'],
    [nList, 'list', nTotal, 'values'], [nTotal, 'scale', 2], [nTotal, 'result', prints[6], 'value'],
    [nDict, 'result', nDescribe, 'fields'], [nDescribe, 'result', prints[7], 'value'],
    [nGreet, 'name', 'Ada'], [nGreet, 'result', prints[8], 'value'], [nKo, '이름', '세종'], [nKo, 'result', prints[9], 'value'],
  );
  await wire(ctx, steps);
  await until(`${V}.compileNow() || true`, 'compiled');
  const compiled = await js(`${VSJ}.compile(${V}.graph(), { fileName: 'calls.pyflow' })`);
  check(!compiled.errors.length, `the graph compiles without problems (${S(compiled.errors)})`);
  const code = compiled.code;
  check(code.includes('import geo.figures\n') && code.includes('import tools.text\n') && code.includes('geo.figures.area(2)') && code.includes('tools.text.area(2, 3)'),
    'two modules that give the same name are imported as modules and called with the module name');
  check(code.includes('from geo.points import Point\n') && code.includes('from helpers import greet, 인사\n') && code.includes('perimeter(3, double=True)') && code.includes('asyncio.run(slow_square(5))') && code.includes('total(*[1, 2, 3], scale=2)') && code.includes("describe(**{'b': 2, 'a': 1})") && code.includes('Rect.square(4)'),
    `other names are imported with from … import, an optional argument left empty is left out with the next one by keyword, async runs through asyncio.run, *args and **kwargs take a list and a dict\n${code}`);
  const out = await run(ctx, ui);
  check(out === '16\n12.57\n6\n6\n5.0\n25\n12\na=1, b=2\nHello, Ada\n안녕, 세종\n', `the script calls the project's functions, classes and methods and prints their real results (${S(out)})`);

  // ---- packages through a dotted search ----
  writeFileSync(path.join(project, 'pkgs.pyflow'), '');
  await js(`ide.refreshTree()`);
  await openScript(ctx, 'pkgs.pyflow');
  await openPalette(ctx, ui);
  await type('math.');
  await until(`!!document.querySelector(${S(row('math', 'sqrt'))})`, 'math is loaded', 30000);
  const sqrtTip = await js(`document.querySelector(${S(row('math', 'sqrt'))}).title`);
  check(/^sqrt\(x, \/\)/.test(sqrtTip), `typing "math." loads the module's functions, with signatures (${S(sqrtTip)})`);
  await press('Escape');
  const nSqrt = await addFromPalette(ctx, ui, 'math.sqr', 'math', 'sqrt');
  const nSeed = await addFromPalette(ctx, ui, 'random.seed', 'random', 'seed');
  const nRand = await addFromPalette(ctx, ui, 'random.randint', 'random', 'randint');
  const nDumps = await addFromPalette(ctx, ui, 'json.dumps', 'json', 'dumps');
  const pp = [];
  for (let i = 0; i < 3; i++) pp.push(await addPlain(ctx, 'io.print'));
  const nL = await addPlain(ctx, 'value.list', { props: { count: 2 }, inputs: { item0: 1, item1: 'a' } });
  await wire(ctx, [
    ['n1', 'next', nSqrt, 'in'], [nSqrt, 'next', pp[0], 'in'], [pp[0], 'next', nSeed, 'in'], [nSeed, 'next', nRand, 'in'], [nRand, 'next', pp[1], 'in'], [pp[1], 'next', nDumps, 'in'], [nDumps, 'next', pp[2], 'in'],
    [nSqrt, 'x', 16], [nSqrt, 'result', pp[0], 'value'], [nSeed, 'a', 42], [nRand, 'a', 1], [nRand, 'b', 100], [nRand, 'result', pp[1], 'value'],
    [nL, 'list', nDumps, 'obj'], [nDumps, 'result', pp[2], 'value'],
  ]);
  const expected = py('import math, random, json\nprint(math.sqrt(16))\nrandom.seed(42)\nprint(random.randint(1, 100))\nprint(json.dumps([1, "a"]))');
  const pkgOut = await run(ctx, ui);
  check(pkgOut === expected && expected.length > 5, `math.sqrt, random.seed + random.randint and json.dumps run with the same output as Python itself (${S(pkgOut)} vs ${S(expected)})`);

  // ---- Browse Package… ----
  await openPalette(ctx, ui);
  await ui.clickOn(`${HOST} .vs-palette .vs-pal-item[data-action="browse"]`);
  await until(`!!document.querySelector('${HOST} .vs-palette .vs-pal-item[data-goto="json"]')`, 'the package list', 30000).catch(async (err) => { throw new Error(`${err.message}: ${await js(`JSON.stringify({ note: document.querySelector('${HOST} .vs-pal-note')?.textContent, input: document.querySelector('${HOST} .vs-pal-input')?.placeholder, rows: document.querySelectorAll('${HOST} .vs-pal-item').length, open: !!document.querySelector('${HOST} .vs-palette') })`)}`); });
  await type('jso');
  await until(`document.querySelector('${HOST} .vs-palette .vs-pal-item')?.dataset.goto === 'json'`, 'filtered package list');
  await press('Enter');
  await until(`document.querySelector('${HOST} .vs-pal-input').value === 'json.' && !!document.querySelector(${S(row('json', 'loads'))})`, 'json. after Browse Package…');
  check(true, 'Browse Package… lists the modules that can be loaded; picking one shows its functions');
  await press('Escape');

  // ---- the project is never imported ----
  const refused = await js(`Promise.all(['geo', 'geo.figures', 'helpers'].map((name) => ide.api.invoke('visual-script:module', { root: ide.root, interp: ${S(interp)}, name })))`);
  check(refused.every((r) => !r.ok && r.reason === 'project'), `main refuses to load a project module as a package (${S(refused.map((r) => r.reason))})`);
  await openPalette(ctx, ui);
  await type('geo.');
  await until(`!!document.querySelector(${S(row('geo.figures', 'area'))}) && !!document.querySelector(${S(row('geo.points', 'New Point'))})`, 'geo. lists project entries');
  check(await js(`!document.querySelector('${HOST} .vs-pal-note:not(.hidden)')`), 'typing "geo." lists the project package\'s entries without loading anything');
  await press('Escape');
  const missing = await js(`${VSJ}.symbols.module('no_such_module_xyz').then(() => 'loaded', (e) => e.message)`);
  check(missing === 'No module named no_such_module_xyz.', `a module that is not installed says so (${S(missing)})`);

  // ---- a signature that changed, Update ----
  await openScript(ctx, 'calls.pyflow');
  const figPath = path.join(project, 'geo', 'figures.py');
  const original = readFileSync(figPath, 'utf8');
  await js(`ide.openFile(${S(figPath)})`);
  await until(`ide.activeTab()?.path.toLowerCase().endsWith('figures.py') && !!ide.editor?.getModel()`, 'figures.py open');
  await js(`(() => { const m = ide.editor.getModel(); m.setValue(m.getValue().replace('def area(r: float) -> float:', 'def area(r: float, digits: int = 1) -> float:').replace('round(math.pi * r * r, 2)', 'round(math.pi * r * r, digits)')); return true; })()`);
  await press('Ctrl+S');
  await until(`!ide.isDirty(ide.activeTab())`, 'figures.py saved');
  await openScript(ctx, 'calls.pyflow');
  await until(`!!document.querySelector('${HOST} .vs-node[data-id=${S(nArea)}] .vs-stale')`, 'the changed signature shows on the node', 30000);
  const stale = await js(`(() => { const n = document.querySelector('${HOST} .vs-node[data-id=${S(nArea)}]'); return { text: n.querySelector('.vs-stale').textContent, others: document.querySelectorAll('${HOST} .vs-stale').length, warn: ${V}.errors().filter((e) => e.node === ${S(nArea)} && e.warning).map((e) => e.message) }; })()`);
  check(stale.text.startsWith("The function's parameters changed") && stale.others === 1 && stale.warn.length === 1, `only the node whose function changed shows "The function's parameters changed" with Update, and a warning (${S(stale)})`);
  await js(`${V}.centerOn(${S(nArea)})`);
  await sleep(300);
  const hit = await js(`(() => { const b = document.querySelector('${HOST} .vs-node[data-id=${S(nArea)}] .vs-update').getBoundingClientRect(); const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return t?.className; })()`);
  await ui.clickOn(`${HOST} .vs-node[data-id=${S(nArea)}] .vs-update`);
  await until(`!document.querySelector('${HOST} .vs-stale')`, `Update applied (the click hit ${hit})`);
  const updated = await js(`(() => { const g = ${V}.graph(); const n = g.nodes.find((x) => x.id === ${S(nArea)}); return { params: n.props.params, r: n.inputs?.r, out: g.links.some((l) => l.from.node === ${S(nArea)} && l.from.pin === 'result'), pins: [...document.querySelectorAll('${HOST} .vs-node[data-id=${S(nArea)}] .vs-pin-in.vs-data')].map((p) => p.dataset.pin) }; })()`);
  check(S(updated.params.map((p) => p.name)) === S(['r', 'digits']) && updated.r === 2 && updated.out && S(updated.pins) === S(['r', 'digits']),
    `Update takes the new parameters and keeps the wires and values of those that still exist (${S(updated)})`);
  const out2 = await run(ctx, ui);
  check(out2.split('\n')[1] === '12.6', `the updated call runs with the new default (${S(out2.split('\n')[1])})`);

  // ---- a function that is gone ----
  await js(`ide.openFile(${S(figPath)})`);
  await until(`ide.activeTab()?.path.toLowerCase().endsWith('figures.py')`, 'figures.py again');
  await js(`(() => { const m = ide.editor.getModel(); m.setValue(m.getValue().replace('async def slow_square(', 'async def slower_square(')); return true; })()`);
  await press('Ctrl+S');
  await until(`!ide.isDirty(ide.activeTab())`, 'figures.py saved again');
  await openScript(ctx, 'calls.pyflow');
  await until(`${V}.errors().some((e) => e.node === ${S(nSlow)} && !e.warning)`, 'the missing function is a problem', 30000);
  const gone = await js(`${V}.errors().find((e) => e.node === ${S(nSlow)}).message`);
  check(gone === 'geo.figures.slow_square no longer exists.' && await js(`document.querySelector('${HOST} .vs-node[data-id=${S(nSlow)}]').classList.contains('vs-err')`), `a function that no longer exists marks its node (${S(gone)})`);
  await run(ctx, ui);
  check(await js(`${runText}.includes('geo.figures.slow_square no longer exists.')`), 'and the run is refused with that problem');
  writeFileSync(figPath, original);

  // ---- a project module the index skipped (geo/huge.py is over 1 MB) is unknown, not gone ----
  const bigState = await js(`(() => { const n = { id: 'x', type: 'py.function', props: { module: 'geo.huge', name: 'huge', params: [] } };
    const g = ${VSJ}.parse(JSON.stringify({ format: 1, nodes: [{ id: 'n1', type: 'core.start' }, n], links: [{ from: { node: 'n1', pin: 'next' }, to: { node: 'x', pin: 'in' } }] }));
    return { status: ${VSJ}.symbolState(g.nodes[1]).status, errors: ${VSJ}.compile(g).errors }; })()`);
  check(bigState.status === 'unknown' && !bigState.errors.some((e) => !e.warning), `a function in geo/huge.py, which the index skipped as too large, is unknown and does not stop the run (${S(bigState)})`);

  await ctx.shot('project.png');
  check(ctx.consoleErrors.length === 0, `no renderer exceptions${ctx.consoleErrors.length ? ` ${S(ctx.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.stack || err.message);
  await ctx.shot('failure.png').catch(() => {});
}
ctx.close();

// ===================================================================== B: Korean
const ko = await sized(await launch({ fixture: 'visual-script-project', port: 9087, name: 'visual-script-project-ko', lang: 'ko-KR' }));
const kui = inputs(ko);
try {
  await openScript(ko, 'calls.pyflow');
  await ko.until(`${VSJ}.symbols.ready() && ${VSJ}.symbols.project().length >= 6`, 'the Korean session reads the index', 30000);
  await openPalette(ko, kui);
  const cats = await ko.js(`[...document.querySelectorAll('${HOST} .vs-palette .vs-pal-cat')].map((h) => h.textContent.replace('▾', ''))`);
  ko.check(cats.includes('프로젝트') && cats.includes('패키지') && await ko.js(`document.querySelector('${HOST} .vs-pal-item[data-action="browse"]').textContent === '패키지 찾아보기…'`), `Project, Packages and Browse Package… are Korean (${S(cats.filter((c) => /[가-힣]/.test(c)))})`);
  const leaks = await englishLeaks(ko, `${HOST} .vs-palette`);
  ko.check(!leaks.length, `the palette with project entries has no English UI text${leaks.length ? `: ${S(leaks.slice(0, 6))}` : ''}`);
  await ko.press('Escape');
  const nRect = await addFromPalette(ko, kui, 'rect', 'geo.figures', '새 Rect');
  ko.check(await ko.js(`document.querySelector('${HOST} .vs-node[data-id=${S(nRect)}] .vs-title').textContent`) === '새 Rect geo.figures', 'a class node is titled 새 Rect');
  const figPath = path.join(ko.project, 'geo', 'figures.py');
  await ko.js(`ide.openFile(${S(figPath)})`);
  await ko.until(`ide.activeTab()?.path.toLowerCase().endsWith('figures.py') && !!ide.editor?.getModel()`, 'figures.py open (Korean)');
  await ko.js(`(() => { const m = ide.editor.getModel(); m.setValue(m.getValue().replace('def __init__(self, w: float, h: float = 1):', 'def __init__(self, w: float, h: float = 1, name: str = "r"):')); return true; })()`);
  await ko.press('Ctrl+S');
  await ko.until(`!ide.isDirty(ide.activeTab())`, 'figures.py saved (Korean)');
  await openScript(ko, 'calls.pyflow');
  await ko.until(`!!document.querySelector('${HOST} .vs-node[data-id=${S(nRect)}] .vs-stale')`, 'Korean stale warning', 30000);
  const staleText = await ko.js(`document.querySelector('${HOST} .vs-stale').textContent`);
  ko.check(staleText === '함수의 매개변수가 바뀌었습니다업데이트', `the warning and Update are Korean (${S(staleText)})`);
  const nodeLeaks = await englishLeaks(ko, `${HOST} .vs-node[data-id=${S(nRect)}]`);
  ko.check(!nodeLeaks.length, `the node has no English UI text${nodeLeaks.length ? `: ${S(nodeLeaks)}` : ''}`);
  await openPalette(ko, kui);
  await ko.type('no_such_module_xyz.');
  await ko.until(`/모듈이 없습니다/.test(document.querySelector('${HOST} .vs-pal-note')?.textContent || '')`, 'Korean load error', 30000);
  ko.check(true, 'a module that cannot be loaded says so in Korean');
  await ko.press('Escape');
  const miss = await missingTranslations(ko);
  ko.check(!miss.length, `every tr() string shown has a Korean entry${miss.length ? `: ${S(miss)}` : ''}`);
  ko.check(ko.consoleErrors.length === 0, `no renderer exceptions (Korean)${ko.consoleErrors.length ? ` ${S(ko.consoleErrors)}` : ''}`);
} catch (err) {
  ko.check(false, err.stack || err.message);
  await ko.shot('failure-ko.png').catch(() => {});
}
for (const r of ko.results) ctx.results.push(r);
ctx.consoleErrors.push(...ko.consoleErrors);
ko.close();

// ===================================================================== C: Safe Mode
{
  const work = mkdtempSync(path.join(tmpdir(), 'pyide-vs-project-safe-'));
  const home = path.join(work, 'home');
  const untrusted = path.join(work, 'downloaded');
  cpSync(path.join(APP, 'verify', 'fixtures', 'visual-script-project'), home, { recursive: true });
  cpSync(path.join(APP, 'verify', 'fixtures', 'visual-script-project'), untrusted, { recursive: true });
  const userData = path.join(work, 'userdata');
  mkdirSync(userData);
  writeFileSync(path.join(userData, 'settings.json'), S({ recentProjects: [{ path: home, opened: Date.now() }] }));
  const t = await sized(await launch({ fixture: 'visual-script-project', port: 9087, name: 'visual-script-project-safe', projectDir: home, userData, env: { PYIDE_TRUST_ALL: '' } }));
  const tui = inputs(t);
  try {
    t.js(`ide.openProject(${S(untrusted)})`).catch(() => {});
    await t.until(`[...document.querySelectorAll('.dialog-title')].some((n) => n.textContent === 'Trust and Open Project?')`, 'trust question');
    await t.js(`[...document.querySelectorAll('.dialog-buttons button')].find((b) => b.textContent === 'Preview in Safe Mode').click()`);
    await t.until(`ide.root && ide.util.samePath(ide.root, ${S(untrusted)}) && ide.trusted === false`, 'Safe Mode');
    await t.sleep(800);
    await openScript(t, 'calls.pyflow');
    await t.sleep(1500);
    t.check(await t.js(`${VSJ}.symbols.project().length === 0 && !${VSJ}.symbols.ready()`), 'Safe Mode: the project index stays empty');
    await openPalette(t, tui);
    const items = await t.js(`[...document.querySelectorAll('${HOST} .vs-palette .vs-pal-item')].filter((r) => r.dataset.module || r.dataset.action).length`);
    const cats = await t.js(`[...document.querySelectorAll('${HOST} .vs-palette .vs-pal-cat')].map((h) => h.textContent.replace('▾', ''))`);
    t.check(items === 0 && !cats.includes('Project') && !cats.includes('Packages'), `Safe Mode: the palette lists no project entries and no Browse Package… (${S(cats)})`);
    await t.type('math.');
    await t.sleep(1500);
    t.check(await t.js(`!document.querySelector('${HOST} .vs-pal-item[data-module]') && !document.querySelector('${HOST} .vs-pal-note:not(.hidden)')`), 'Safe Mode: typing "math." loads nothing');
    await t.press('Escape');
    const answers = await t.js(`(async () => { const i = ide.currentInterp() || { cmd: 'py', args: ['-3'] }; const interp = { cmd: i.cmd, args: i.args || [] };
      return [await ide.api.invoke('visual-script:symbols', { root: ide.root, interp }), await ide.api.invoke('visual-script:module', { root: ide.root, interp, name: 'math' }), await ide.api.invoke('visual-script:packages', { root: ide.root, interp })]; })()`);
    t.check(answers[0].trusted === false && !answers[0].modules.length && answers[1].reason === 'untrusted' && answers[2].reason === 'untrusted', `Safe Mode: main refuses the index, a package module and the package list (${S(answers.map((a) => a.reason || a.trusted))})`);
    t.check(t.consoleErrors.length === 0, `no renderer exceptions (Safe Mode)${t.consoleErrors.length ? ` ${S(t.consoleErrors)}` : ''}`);
  } catch (err) {
    t.check(false, err.stack || err.message);
    await t.shot('failure-safe.png').catch(() => {});
  }
  for (const r of t.results) ctx.results.push(r);
  ctx.consoleErrors.push(...t.consoleErrors);
  t.close();
}
ctx.finish();
