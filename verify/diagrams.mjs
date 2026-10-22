// Python class diagrams (renderer/features/diagrams, main/features/diagrams.js). Ports 9040-9042.
// A: the fixture project (src layout, inheritance across modules incl. multiple inheritance, a dataclass, an Enum,
// properties, associations, a syntax error, a module with side effects): cancelling a parse, the project tree's
// Show Diagram, contents and arrows, toggles, selection, double-click navigation, Delete, Add Class…, zoom and pan,
// the editor entry (context action and Ctrl+Alt+Shift+U), the parse cache, SVG and PNG export, Light theme.
// B: a generated 300-class project: layout time, no overlaps, render and pan frame times.
// C: Korean UI.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { launch, openFile, tempDir } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const S = JSON.stringify;
const require = createRequire(import.meta.url);
const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const { moduleNames, buildModel } = require(path.join(APP, 'main', 'diagrams', 'model.js'));

let failures = 0;
const pure = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failures++; };

// ---------- pure model resolution ----------
{
  const root = 'C:\\proj';
  const inits = new Set(['C:\\proj\\src\\pkg', 'C:\\proj\\src\\pkg\\sub']);
  const names = moduleNames('C:\\proj\\src\\pkg\\sub\\mod.py', root, (d) => inits.has(d));
  pure(names[0] === 'pkg.sub.mod' && names.includes('src.pkg.sub.mod'), `module names follow the package chain and src layout (${names.join(', ')})`);
  const cls = (name, bases = [], fields = []) => ({ name, qualname: name, line: 1, col: 1, endLine: 2, bases, decorators: [], dataclass: false, metaclass: null, fields, methods: [] });
  const files = [
    { path: 'a/__init__.py', modules: ['a'], inScope: true, info: { imports: [{ kind: 'from', module: 'base', level: 1, names: [{ name: 'Root', as: 'R' }] }, { kind: 'from', module: 'star', level: 1, names: [{ name: '*', as: null }] }], classes: [] } },
    { path: 'a/base.py', modules: ['a.base'], inScope: true, info: { imports: [], classes: [cls('Root')] } },
    { path: 'a/star.py', modules: ['a.star'], inScope: true, info: { imports: [{ kind: 'from', module: 'base', level: 1, names: [{ name: 'Root', as: null }] }, { kind: 'alias', name: 'Alias', target: 'Mid' }], classes: [cls('Mid', ['Root'])] } },
    { path: 'b.py', modules: ['b'], inScope: true, info: { imports: [{ kind: 'import', module: 'a', as: 'pkg' }, { kind: 'from', module: 'a', level: 0, names: [{ name: 'Alias', as: null }] }],
      classes: [cls('Leaf', ['pkg.R', 'Alias'], [{ name: 'other', kind: 'annotated', type: 'list[pkg.base.Root]', refs: [{ name: 'pkg.base.Root', many: true }] }])] } },
  ];
  const m = buildModel(files);
  const q = (id) => id.split('::')[1];
  const e = m.edges.map((x) => `${x.kind}:${q(x.from)}>${q(x.to)}${x.many ? '*' : ''}`).sort();
  pure(S(e) === S(['assoc:Leaf>Root*', 'extends:Leaf>Mid', 'extends:Leaf>Root', 'extends:Mid>Root']), `aliases, star imports and re-exports resolve (${e.join(' ')})`);
}

// ---------- export writes only a path the Save dialog returned (main, with a stub dialog) ----------
{
  const Module = require('module');
  const electronId = require.resolve('electron');
  const featureId = require.resolve(path.join(APP, 'main', 'features', 'diagrams.js'));
  const prevElectron = require.cache[electronId];
  const prevDir = process.env.PYIDE_DIAGRAMS_SAVE_DIR;
  const dir = tempDir('diagrams-guard');
  const picked = path.join(dir, 'picked.svg');
  const stub = new Module(electronId);
  stub.exports = { dialog: { showSaveDialog: async () => ({ canceled: false, filePath: picked }) } };
  stub.loaded = true;
  require.cache[electronId] = stub;
  delete require.cache[featureId];
  delete process.env.PYIDE_DIAGRAMS_SAVE_DIR;
  try {
    const handlers = {};
    require(featureId).register({ ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, send() {}, getWindow: () => null, appDir: APP });
    const write = (file) => handlers['diagrams:write'](null, file, 'svg', '<svg/>').then(() => 'written', (e) => e.message);
    const other = path.join(dir, 'other.svg');
    const refused = await write(other);
    const got = await handlers['diagrams:savePath'](null, 'svg', 'x.svg');
    const ok = await write(got);
    pure(refused === 'The file was not chosen in the Save dialog' && !existsSync(other) && got === picked && ok === 'written' && readFileSync(picked, 'utf8') === '<svg/>',
      `diagrams:write refuses a path the Save dialog did not return and writes the one it did (${refused}; ${ok})`);
    process.env.PYIDE_DIAGRAMS_SAVE_DIR = dir;
    const inDir = await write(path.join(dir, 'test.svg'));
    const below = await write(path.join(dir, 'sub', 'test.svg'));
    pure(inDir === 'written' && below === 'The file was not chosen in the Save dialog', `with PYIDE_DIAGRAMS_SAVE_DIR only files directly in that folder are writable (${inDir}; ${below})`);
  } finally {
    if (prevElectron) require.cache[electronId] = prevElectron; else delete require.cache[electronId];
    delete require.cache[featureId];
    if (prevDir === undefined) delete process.env.PYIDE_DIAGRAMS_SAVE_DIR; else process.env.PYIDE_DIAGRAMS_SAVE_DIR = prevDir;
  }
}

const saveDir = tempDir('diagrams-export');
const overlaps = (cls) => {
  const out = [];
  for (let i = 0; i < cls.length; i++) for (let j = i + 1; j < cls.length; j++) {
    const a = cls[i];
    const b = cls[j];
    if (a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1) out.push(`${a.qualname}/${b.qualname}`);
  }
  return out;
};
// DIAGRAMS_ONLY=fixture|big|ko runs one part while debugging.
const ONLY = process.env.DIAGRAMS_ONLY || '';
let resA = 0;
let resB = 0;
let resC = 0;

// ---------- A: the fixture ----------
if (!ONLY || ONLY === 'fixture') {
const t = await launch({ fixture: 'diagrams', port: 9040, env: { PYIDE_DIAGRAMS_SAVE_DIR: saveDir } });
const { js, until, check, press, cdp, sleep } = t;
const abs = (rel) => path.join(t.project, ...rel.split('/'));
const st = () => js('ide.diagrams.state()');
const names = (s) => s.classes.map((c) => c.qualname).sort();
const hasEdge = (s, from, to, kind) => s.edges.some((e) => e.from === from && e.to === to && e.kind === kind);
const nodeCenter = (qualname) => js(`(() => {
  const d = ide.diagrams.get(); const id = ide.diagrams.findClass(${S(qualname)});
  const n = [...d.svg.querySelectorAll('.dg-node')].find((x) => x.dataset.id === id);
  if (!n) return null; const r = n.querySelector('.dg-box').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + Math.min(14, r.height / 2) };
})()`);
const mouse = async (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
const clickAt = async ({ x, y }, clickCount = 1) => { await mouse('mousePressed', x, y, { clickCount }); await mouse('mouseReleased', x, y, { clickCount }); await sleep(60); };
// A point of the canvas outside every class box.
const emptyPoint = () => js(`(() => {
  const c = ide.diagrams.get().canvas.getBoundingClientRect();
  for (let y = c.top + 6; y < c.bottom; y += 23) for (let x = c.left + 6; x < c.right; x += 31) {
    const n = document.elementFromPoint(x, y);
    if (n && n.closest('.dg-canvas') && !n.closest('.dg-node') && !n.closest('.dg-edge')) return { x, y };
  }
  return null;
})()`);

try {
  // ---------- cancelling ----------
  await js('(ide.diagrams.slowMs = 500, true)');
  await js(`(window.__dgCancel = ide.diagrams.showPaths([ide.root]), true)`);
  await until(`ide.tasks.list().some((x) => x.title === 'Building class diagram')`, 'diagram task shown');
  await js(`ide.tasks.cancel(ide.tasks.list().find((x) => x.title === 'Building class diagram').id), true`);
  check(await js('window.__dgCancel.then((r) => r === null)'), 'cancelling the background task ends the request without a diagram');
  check(await js(`!ide.tasks.list().some((x) => x.title === 'Building class diagram') && !ide.tabs.some((x) => String(x.path).startsWith('pyide-diagram:'))`), 'no task and no diagram tab are left');
  await js('(ide.diagrams.slowMs = 0, true)');

  // ---------- project tree › Show Diagram on a package ----------
  const pkg = abs('src/shapes');
  await js(`ide.revealInTree(${S(pkg)})`);
  const rowOf = `[...document.querySelectorAll('#tree .node')].find((n) => n._entry?.path.toLowerCase() === ${S(pkg.toLowerCase())})`;
  await until(`!!${rowOf}`, 'tree row src/shapes');
  await js(`(() => { const n = ${rowOf}; const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 20, clientY: r.y + 8 })); return true; })()`);
  await until(`[...document.querySelectorAll('.context-menu .menu-label')].some((l) => l.textContent === 'Show Diagram')`, 'Show Diagram in the tree menu');
  check(await js(`[...document.querySelectorAll('.context-menu .menu-item')].find((r) => r.querySelector('.menu-label')?.textContent === 'Show Diagram')?.textContent.includes('Ctrl+Alt+Shift+U')`), 'the tree item shows the Ctrl+Alt+Shift+U shortcut');
  await js(`[...document.querySelectorAll('.context-menu .menu-item')].find((r) => r.querySelector('.menu-label')?.textContent === 'Show Diagram').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), true`);
  await until(`document.querySelector('.dg-root')?.dataset.state === 'ready' && ide.activeTab()?.kind === 'custom'`, 'diagram tab ready', 30000);
  let s = await st();
  check(S(names(s)) === S(['Canvas', 'Circle', 'Color', 'Danger', 'Named', 'Shape', 'Square', 'Square.Corner', 'Styled', 'StyledCircle']), `the package's classes are shown (${names(s).join(', ')})`);
  check(!names(s).includes('Big') && !names(s).includes('ToolShape'), 'classes outside the package are not');
  check(hasEdge(s, 'Shape', 'Named', 'extends') && hasEdge(s, 'Circle', 'Shape', 'extends') && hasEdge(s, 'Square', 'Shape', 'extends'), 'inheritance across modules (relative import, import a.b)');
  check(hasEdge(s, 'StyledCircle', 'Circle', 'extends') && hasEdge(s, 'StyledCircle', 'Styled', 'extends'), 'multiple inheritance draws two arrows');
  check(s.edges.some((e) => e.from === 'Canvas' && e.to === 'Shape' && e.kind === 'assoc' && e.many && e.label === 'shapes'), 'List["shapes.base.Shape"] is a to-many association');
  check(hasEdge(s, 'Canvas', 'Color', 'assoc') && hasEdge(s, 'Styled', 'Color', 'assoc') && hasEdge(s, 'Canvas', 'StyledCircle', 'assoc'), 'aliased, module-attribute and TYPE_CHECKING annotations resolve');
  check(hasEdge(s, 'Styled', 'Named', 'assoc'), 'self.x: "b.Named | None" in __init__ is an association');
  const stereo = Object.fromEntries(s.classes.map((c) => [c.qualname, c.stereotype]));
  check(stereo.Color === 'enum' && stereo.Canvas === 'dataclass' && stereo.Shape === 'abstract' && stereo.Circle === '', 'stereotypes: «enum», «dataclass», «abstract»');
  check(s.stats.errors.length === 1 && /broken\.py$/.test(s.stats.errors[0].path) && /SyntaxError/.test(s.stats.errors[0].error), 'the file with a syntax error is reported, not fatal');
  check(await js(`/1 file could not be parsed/.test(document.querySelector('.dg-status').textContent)`), 'the status line counts the unparsed file');
  check(!existsSync(abs('src/shapes/PWNED.txt')), 'user code is never run (danger.py did not write PWNED.txt)');
  check(overlaps(s.classes).length === 0, `no boxes overlap (${overlaps(s.classes).join(' ')})`);
  const by = Object.fromEntries(s.classes.map((c) => [c.qualname, c]));
  check(by.Named.y + by.Named.h <= by.Shape.y && by.Shape.y + by.Shape.h <= by.Circle.y && by.Circle.y + by.Circle.h <= by.StyledCircle.y, 'bases sit above their subclasses');
  check(s.edges.filter((e) => e.kind === 'extends').every((e) => { const p = e.points[e.points.length - 1]; const b = by[e.to]; return Math.abs(p[1] - (b.y + b.h)) < 0.5 && p[0] >= b.x && p[0] <= b.x + b.w; }), 'inheritance arrows end on the base\'s bottom edge');
  check(await js(`document.querySelectorAll('.dg-ext polygon.dg-arrow').length === ${s.edges.filter((e) => e.kind === 'extends').length} && document.querySelectorAll('.dg-assoc polyline.dg-arrow').length === ${s.edges.filter((e) => e.kind === 'assoc').length}`), 'hollow triangles on inheritance, open arrows on associations');

  // ---------- members ----------
  const rows = (q) => js(`(() => { const d = ide.diagrams.get(); const id = ide.diagrams.findClass(${S(q)});
    const n = [...d.svg.querySelectorAll('.dg-node')].find((x) => x.dataset.id === id);
    return [...n.querySelectorAll('.dg-m')].map((m) => ({ text: m.querySelector('.dg-mt').textContent, cls: m.getAttribute('class'), icon: m.querySelector('.dg-ic-t').textContent })); })()`);
  const shapeRows = await rows('Shape');
  const row = (list, start) => list.find((r) => r.text.startsWith(start));
  check(row(shapeRows, 'area(): float')?.cls.includes('dg-abs'), 'abstract method in italics');
  check(row(shapeRows, 'kind: str')?.icon === 'p' && shapeRows.filter((r) => r.text.startsWith('kind')).length === 1, 'property shown once (setter folded in)');
  check(row(shapeRows, 'unit(): str')?.cls.includes('dg-static'), 'static method underlined');
  check(row(shapeRows, 'create(name: str): \'Shape\'')?.icon === 'c' || row(shapeRows, 'create(')?.icon === 'c', 'class method marked c');
  check(!!row(shapeRows, 'async render(scale: float): None'), 'async method');
  check(!!row(shapeRows, 'sides: int'), 'annotated class attribute');
  const namedRows = await rows('Named');
  check(!!row(namedRows, 'name: str') && row(namedRows, '_secret')?.cls.includes('dg-vis-protected') && row(namedRows, '__very_private')?.cls.includes('dg-vis-private'),
    'self.x in __init__ with the parameter\'s type, protected and private visibility');
  check(!!row(namedRows, '__mangled()') && !!row(namedRows, 'label'), 'private method and class attribute');
  const colorRows = await rows('Color');
  check(['RED', 'GREEN', 'BLUE'].every((n) => colorRows.some((r) => r.text === n && r.icon === 'e')), 'Enum members');
  const canvasRows = await rows('Canvas');
  check(!!row(canvasRows, 'title: str') && row(canvasRows, 'count: ClassVar[int]')?.cls.includes('dg-static') && !!row(canvasRows, 'highlight: \'StyledCircle | None\''), 'dataclass fields and a ClassVar');

  // ---------- toggles ----------
  const counts = () => js(`({ f: document.querySelectorAll('.dg-m-field').length, m: document.querySelectorAll('.dg-m-method').length, p: document.querySelectorAll('.dg-vis-private, .dg-vis-protected').length })`);
  const before = await counts();
  await t.click('.dg-fields');
  await until(`document.querySelectorAll('.dg-m-field').length === 0`, 'fields hidden');
  check((await counts()).m === before.m && await js(`document.querySelector('.dg-fields').getAttribute('aria-pressed') === 'false'`), 'Fields toggle hides only fields');
  check(overlaps((await st()).classes).length === 0, 'boxes shrink without overlapping');
  await t.click('.dg-methods');
  await until(`document.querySelectorAll('.dg-m').length === 0`, 'methods hidden');
  await t.click('.dg-fields');
  await t.click('.dg-methods');
  await until(`document.querySelectorAll('.dg-m-field').length === ${before.f} && document.querySelectorAll('.dg-m-method').length === ${before.m}`, 'members back');
  await t.click('.dg-private');
  await until(`document.querySelectorAll('.dg-vis-private, .dg-vis-protected').length === 0`, 'private hidden');
  check((await counts()).f + (await counts()).m === before.f + before.m - before.p && await js(`ide.settings.get('diagrams.showPrivate') === false`), 'Private toggle hides _ and __ members and is remembered');
  await t.click('.dg-private');
  await until(`document.querySelectorAll('.dg-vis-private, .dg-vis-protected').length === ${before.p}`, 'private back');

  // ---------- selection, navigation, Delete ----------
  await clickAt(await nodeCenter('Circle'));
  check(await js(`document.querySelector('.dg-root').dataset.selected === ide.diagrams.findClass('Circle')`), 'clicking a class selects it');
  check(await js(`(() => { const hl = [...document.querySelectorAll('.dg-edge.dg-hl')].map((e) => e.dataset.from + '>' + e.dataset.to);
    const c = ide.diagrams.findClass('Circle'); return hl.length === 2 && hl.every((x) => x.includes(c)) && document.querySelector('.dg-svg').classList.contains('dg-has-sel'); })()`), 'its two relations are highlighted, the rest dimmed');
  check(await js(`[...document.querySelectorAll('.dg-node.dg-rel')].map((n) => n.dataset.id).sort().join() === [ide.diagrams.findClass('Shape'), ide.diagrams.findClass('StyledCircle')].sort().join()`), 'related classes are marked');
  await clickAt(await nodeCenter('Circle'), 2);
  await until(`ide.activeTab()?.path?.toLowerCase().endsWith('circle.py')`, 'double-click opened circle.py');
  check(await js(`ide.editor.getPosition().lineNumber === 4`), 'double-click jumps to the class line');
  await js(`(ide.openCustomTab({ id: ide.tabs.find((x) => String(x.path).startsWith('pyide-diagram:scope:')).path, mount() {} }), true)`);
  await until(`ide.activeTab()?.kind === 'custom'`, 'back on the diagram');
  await clickAt(await nodeCenter('Danger'));
  await press('Delete');
  await until(`!ide.diagrams.state().classes.some((c) => c.qualname === 'Danger')`, 'Delete removed Danger');
  check(true, 'Delete removes the selected class from the diagram');

  // ---------- Add Class… ----------
  await t.click('.dg-add');
  await until(`document.querySelector('#popupIn') && [...document.querySelectorAll('#popupList .popup-item')].some((r) => r.textContent.includes('Big'))`, 'Add Class popup lists Big', 30000);
  await t.type('Big');
  await press('Enter');
  await until(`ide.diagrams.state().classes.some((c) => c.qualname === 'Big')`, 'Big added');
  s = await st();
  check(hasEdge(s, 'Big', 'Circle', 'extends'), 'an added class from another source root links to its base (from shapes.circle import Circle as C)');
  check(s.selected === s.classes.find((c) => c.qualname === 'Big').id && overlaps(s.classes).length === 0, 'the added class is selected and the layout stays free of overlaps');
  await js(`ide.diagrams.addClass(ide.diagrams.findClass('ToolShape'))`);
  s = await st();
  check(hasEdge(s, 'ToolShape', 'Shape', 'extends'), 'import shapes; shapes.Shape resolves through the package __init__ re-export');

  // ---------- zoom and pan ----------
  const view0 = (await st()).view;
  const c0 = await js(`(() => { const r = document.querySelector('.dg-canvas').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c0.x, y: c0.y, deltaX: 0, deltaY: -240, modifiers: 2 });
  await until(`ide.diagrams.state().view.s > ${view0.s * 1.3}`, 'Ctrl+wheel zoomed in');
  check(true, 'Ctrl+wheel zooms in around the cursor');
  await t.click('.dg-fit');
  await sleep(100);
  check(await js(`(() => { const r = document.querySelector('.dg-svg').getBoundingClientRect(); const c = document.querySelector('.dg-canvas').getBoundingClientRect();
    return r.left >= c.left - 1 && r.right <= c.right + 1 && r.top >= c.top - 1 && r.bottom <= c.bottom + 1; })()`), 'Fit Content shows the whole diagram');
  const v1 = (await st()).view;
  const ep = await emptyPoint();
  await mouse('mousePressed', ep.x, ep.y);
  for (let i = 1; i <= 5; i++) await mouse('mouseMoved', ep.x + i * 10, ep.y + i * 6);
  await mouse('mouseReleased', ep.x + 50, ep.y + 30);
  await sleep(60);
  const v2 = (await st()).view;
  check(Math.abs(v2.tx - v1.tx - 50) < 1 && Math.abs(v2.ty - v1.ty - 30) < 1, 'dragging the background pans');
  await js(`(document.querySelector('.dg-canvas').dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true })), true)`);
  await until(`ide.diagrams.state().view.s < ${v2.s}`, 'minus zooms out');
  check(true, 'keys - and + zoom while the diagram has focus');

  // ---------- export ----------
  check(await js(`document.querySelector('.dg-export-svg').title === 'Export as SVG…'`), 'export buttons');
  await t.click('.dg-export-svg');
  const svgFile = path.join(saveDir, 'shapes.svg');
  for (let i = 0; i < 50 && !existsSync(svgFile); i++) await sleep(100);
  const svgText = existsSync(svgFile) ? readFileSync(svgFile, 'utf8') : '';
  s = await st();
  check(svgText.startsWith('<?xml') && /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(svgText), 'Export as SVG writes a standalone SVG through the save path');
  check(['StyledCircle', 'Canvas', 'Color', 'Big', 'ToolShape', 'shapes.base'].every((n) => svgText.includes(`>${n}<`)) && !svgText.includes('>Danger<'), 'the SVG holds the shown classes and module names');
  check((svgText.match(/<polygon class="dg-arrow"/g) || []).length === s.edges.filter((e) => e.kind === 'extends').length && (svgText.match(/<polyline class="dg-arrow"/g) || []).length === s.edges.filter((e) => e.kind === 'assoc').length,
    'the SVG has every arrow');
  check(!svgText.includes('var(--') && /\.dg-box \{ fill: #2b2d30/.test(svgText) && !/class="[^"]*dg-(has-)?sel/.test(svgText), 'the SVG carries the Dark colours, not variables or the selection');
  const png = await js(`ide.diagrams.exportPng(${S(path.join(saveDir, 'shapes.png'))})`);
  const buf = readFileSync(path.join(saveDir, 'shapes.png'));
  const pw = buf.readUInt32BE(16);
  const ph = buf.readUInt32BE(20);
  const expectW = Math.ceil((s.width + 80) * 2);
  check(buf.slice(1, 4).toString() === 'PNG' && pw === png.width && ph === png.height && Math.abs(pw - expectW) <= 1, `PNG export at twice the diagram size (${pw}x${ph}, diagram ${Math.round(s.width)}x${Math.round(s.height)})`);
  check(buf.length > 5000, `the PNG is drawn (${buf.length} bytes)`);

  // ---------- Light theme ----------
  await js(`(ide.settings.set('appearance.theme', 'light'), true)`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'light theme');
  check(await js(`getComputedStyle(document.querySelector('.dg-box')).fill === 'rgb(255, 255, 255)' && getComputedStyle(document.querySelector('.dg-name')).fill === 'rgb(30, 31, 34)'`), 'Light theme colours on screen');
  await js(`ide.diagrams.exportSvg(${S(path.join(saveDir, 'light.svg'))})`);
  check(/\.dg-box \{ fill: #ffffff/.test(readFileSync(path.join(saveDir, 'light.svg'), 'utf8')), 'an export in the Light theme uses its colours');
  await js(`(ide.settings.set('appearance.theme', 'dark'), true)`);
  await t.shot('fixture-diagram.png');

  // ---------- editor entry: class at the caret ----------
  await openFile(t, 'src/shapes/styled.py');
  await js(`(ide.editor.setPosition({ lineNumber: 15, column: 9 }), ide.editor.focus(), true)`);
  check(await js(`!!ide.editor.getAction('pyide.showUmlDiagram')`), 'Show Diagram is in the Python editor context menu');
  await js(`ide.editor.getAction('pyide.showUmlDiagram').run().then(() => true)`);
  await until(`ide.activeTab()?.path === 'pyide-diagram:class:' + ide.diagrams.findClass('StyledCircle')?.toLowerCase() && ide.diagrams.get()?.host?.dataset.state === 'ready'`, 'class diagram for StyledCircle', 30000);
  s = await st();
  check(S(names(s)) === S(['Canvas', 'Circle', 'Named', 'Shape', 'Styled', 'StyledCircle']), `a class shows with its bases and relations (${names(s).join(', ')})`);
  await openFile(t, 'src/shapes/base.py');
  await js(`(ide.editor.setPosition({ lineNumber: 24, column: 9 }), ide.editor.focus(), true)`);
  await press('Ctrl+Alt+Shift+U');
  await until(`ide.activeTab()?.path === 'pyide-diagram:class:' + ide.diagrams.findClass('Shape')?.toLowerCase() && ide.diagrams.get()?.host?.dataset.state === 'ready'`, 'Ctrl+Alt+Shift+U on Shape', 30000);
  s = await st();
  check(['Named', 'Shape', 'Circle', 'Square', 'StyledCircle', 'ToolShape', 'Canvas'].every((n) => names(s).includes(n)) && !names(s).includes('Color'),
    `Ctrl+Alt+Shift+U shows Shape, its base, all subclasses and associated classes (${names(s).join(', ')})`);
  check(overlaps(s.classes).length === 0, 'no overlaps in the class diagram');

  // ---------- cache ----------
  await openFile(t, 'src/shapes/base.py');
  await js(`(ide.editor.setPosition({ lineNumber: 24, column: 9 }), true)`);
  await js(`ide.diagrams.showAt(${S(abs('src/shapes/base.py'))}, 24)`);
  s = await st();
  check(s.stats.parsed === 0 && s.stats.cached >= 10, `a second diagram reads every file from the cache (parsed ${s.stats.parsed}, cached ${s.stats.cached})`);
  appendFileSync(abs('src/shapes/circle.py'), '\n\nclass Ring(Circle):\n    inner: float = 0.5\n');
  await js(`ide.diagrams.showAt(${S(abs('src/shapes/base.py'))}, 24)`);
  await until(`ide.diagrams.state().classes.some((c) => c.qualname === 'Ring')`, 'Ring appears');
  s = await st();
  check(s.stats.parsed <= 1 && s.stats.cached >= s.stats.files + s.stats.extra - 1 && hasEdge(s, 'Ring', 'Circle', 'extends'), `only the changed file is parsed again (parsed ${s.stats.parsed}, cached ${s.stats.cached})`);
  // An unsaved buffer is read as the editor shows it.
  await openFile(t, 'src/shapes/colors.py');
  await js(`(() => { const m = ide.editor.getModel(); m.pushEditOperations([], [{ range: new ide.monaco.Range(1, 1, 1, 1), text: 'class Pending:\\n    pass\\n\\n\\n' }], () => null); return true; })()`);
  await js(`ide.diagrams.showPaths([${S(abs('src/shapes/colors.py'))}])`);
  await until(`ide.diagrams.state()?.classes.some((c) => c.qualname === 'Pending')`, 'unsaved class shown');
  check(true, 'a file diagram reads unsaved editor text');
  await js(`(ide.editor.getModel() && ide.closeTab(${S(abs('src/shapes/colors.py'))}, true), true)`);
  check(t.consoleErrors.length === 0, 'no renderer exceptions');
  check((await js('ide.diagnostics?.errors?.().length ?? 0')) === 0, 'no internal errors');
} catch (err) {
  check(false, err.message);
  await t.shot('fixture-failure.png').catch(() => {});
}
resA = t.results.filter((r) => !r.ok).length + t.consoleErrors.length;
console.log(`A: ${t.results.length - t.results.filter((r) => !r.ok).length}/${t.results.length} passed`);
t.close();
}

// ---------- B: 300 generated classes ----------
if (!ONLY || ONLY === 'big') {
const gen = tempDir('diagrams-big');
mkdirSync(path.join(gen, 'big'), { recursive: true });
writeFileSync(path.join(gen, 'big', '__init__.py'), '');
const MODS = 30;
const PER = 10;
for (let m = 0; m < MODS; m++) {
  const lines = ['from typing import List, Optional', ''];
  const imported = new Set();
  const body = [];
  for (let j = 0; j < PER; j++) {
    const k = m * PER + j;
    const base = k % 5 === 0 || k === 0 ? null : Math.floor((k - 1) / 3);
    let baseRef = '';
    if (base !== null) {
      const bm = Math.floor(base / PER);
      if (bm !== m && !imported.has(base)) { lines.push(`from big.m${bm} import C${base}`); imported.add(base); }
      baseRef = `(C${base})`;
    }
    const target = (k * 7 + 3) % (MODS * PER);
    const tm = Math.floor(target / PER);
    const assoc = k % 4 === 0 ? (tm === m ? `"C${target}"` : `"big.m${tm}.C${target}"`) : null;
    if (assoc && tm !== m) lines.push(`import big.m${tm}`);
    body.push(`class C${k}${baseRef}:`, `    count: int = 0`, `    label: str = "c${k}"`,
      assoc ? `    peer: Optional[${assoc}] = None` : `    peers: List[int] = []`,
      `    def __init__(self, size: int = 1):`, `        self.size = size`, `        self._cache = {}`,
      `    def run(self, steps: int) -> int:`, `        return steps`, `    def _helper(self):`, `        return None`,
      `    @property`, `    def name(self) -> str:`, `        return "c${k}"`, '', '');
  }
  writeFileSync(path.join(gen, 'big', `m${m}.py`), [...lines, '', '', ...body].join('\n'));
}
const b = await launch({ name: 'diagrams-big', port: 9041, projectDir: gen, fixture: 'diagrams' });
try {
  const t0 = Date.now();
  const tab = await b.js(`ide.diagrams.showPaths([ide.root])`);
  await b.until(`document.querySelector('.dg-root')?.dataset.state === 'ready'`, '300-class diagram', 60000);
  const total = Date.now() - t0;
  const s = await b.js('ide.diagrams.state()');
  b.check(!!tab && s.classes.length === 300, `300 classes shown (${s.classes.length})`);
  b.check(s.edges.filter((e) => e.kind === 'extends').length === 300 - 60 && s.edges.filter((e) => e.kind === 'assoc').length === 75, `inheritance and associations across 30 modules (${s.edges.filter((e) => e.kind === 'extends').length} extends, ${s.edges.filter((e) => e.kind === 'assoc').length} assoc)`);
  b.check(s.timing.layout < 1000 && s.timing.measureAndLayout < 1000, `layout under 1 s (layout ${s.timing.layout.toFixed(0)} ms, with measuring ${s.timing.measureAndLayout.toFixed(0)} ms; SVG ${s.timing.render.toFixed(0)} ms; parse ${s.stats.ms} ms; total ${total} ms)`);
  b.check(overlaps(s.classes).length === 0, `no overlapping boxes among 300 (${overlaps(s.classes).slice(0, 5).join(' ')})`);
  const byName = Object.fromEntries(s.classes.map((c) => [c.qualname, c]));
  b.check(s.edges.filter((e) => e.kind === 'extends').every((e) => byName[e.to].y + byName[e.to].h <= byName[e.from].y), 'every base is above its subclasses');
  // Pan: drag the background for 90 moves while the page records its frame times, at the fitted scale and at 1:1.
  const panFrames = async (label) => {
    await b.js(`(() => { window.__frames = []; window.__stopFrames = false; let last = performance.now(); const loop = (now) => { window.__frames.push(now - last); last = now; if (window.__frames.length < 400 && !window.__stopFrames) requestAnimationFrame(loop); }; requestAnimationFrame(loop); return true; })()`);
    const ep2 = await b.js(`(() => { const c = document.querySelector('.dg-canvas').getBoundingClientRect();
      for (let y = c.top + 6; y < c.bottom; y += 13) for (let x = c.left + 6; x < c.right; x += 17) { const n = document.elementFromPoint(x, y); if (n && n.closest('.dg-canvas') && !n.closest('.dg-node')) return { x, y }; } return null; })()`);
    const v0 = await b.js('ide.diagrams.state().view');
    await b.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: ep2.x, y: ep2.y, button: 'left', clickCount: 1 });
    const moveStart = Date.now();
    for (let i = 1; i <= 90; i++) {
      await b.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ep2.x + Math.sin(i / 9) * 200, y: ep2.y + i * 2, button: 'left' });
      await b.sleep(8);
    }
    await b.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ep2.x, y: ep2.y + 180, button: 'left', clickCount: 1 });
    const moveMs = Date.now() - moveStart;
    const frames = await b.js(`(() => { window.__stopFrames = true; return window.__frames.slice(2); })()`);
    const sorted = [...frames].sort((x, y) => x - y);
    const pct = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    const v1 = await b.js('ide.diagrams.state().view');
    b.check(Math.abs(v1.ty - v0.ty - 180) < 1, `the drag panned the 300-class diagram (${label})`);
    b.check(pct(0.5) < 25 && pct(0.95) < 50, `pan frame times at ${label}: median ${pct(0.5).toFixed(1)} ms, p95 ${pct(0.95).toFixed(1)} ms, max ${sorted[sorted.length - 1].toFixed(1)} ms over ${frames.length} frames (${moveMs} ms of moves)`);
  };
  await panFrames(`fit (scale ${(await b.js('ide.diagrams.state().view.s')).toFixed(2)})`);
  await b.js('(ide.diagrams.get().setScale(1), true)');
  await b.sleep(300);
  await panFrames('1:1');
  // Zooming re-renders the SVG at the new size; time a zoom step.
  const zoomMs = await b.js(`new Promise((res) => { const t0 = performance.now(); ide.diagrams.get().zoomBy(1.5); requestAnimationFrame(() => requestAnimationFrame(() => res(performance.now() - t0))); })`);
  b.check(zoomMs < 250, `a zoom step paints in ${zoomMs.toFixed(0)} ms`);
  const relayoutMs = await b.js(`(() => { const t0 = performance.now(); document.querySelector('.dg-fields').click(); return performance.now() - t0; })()`);
  b.check(relayoutMs < 1000, `toggling fields relayouts 300 classes in ${relayoutMs.toFixed(0)} ms`);
  b.check(b.consoleErrors.length === 0, 'no renderer exceptions');
  await b.shot('big-diagram.png');
} catch (err) {
  b.check(false, err.message);
}
resB = b.results.filter((r) => !r.ok).length + b.consoleErrors.length;
console.log(`B: ${b.results.length - b.results.filter((r) => !r.ok).length}/${b.results.length} passed`);
b.close();
}

// ---------- C: Korean ----------
if (!ONLY || ONLY === 'ko') {
const k = await launch({ fixture: 'diagrams', name: 'diagrams-ko', port: 9042, lang: 'ko-KR' });
try {
  await k.js(`ide.diagrams.showPaths([ide.util.joinPath(ide.util.joinPath(ide.root, 'src'), 'shapes')])`);
  await k.until(`document.querySelector('.dg-root')?.dataset.state === 'ready'`, 'Korean diagram', 30000);
  k.check(await k.js(`document.querySelector('.dg-fields').textContent === '필드' && document.querySelector('.dg-add').textContent === '클래스 추가…' && document.querySelector('.dg-export-svg').title === 'SVG로 내보내기…'`), 'toolbar in Korean');
  k.check(await k.js(`/클래스 10개/.test(document.querySelector('.dg-status').textContent)`), `status in Korean (${await k.js(`document.querySelector('.dg-status').textContent`)})`);
  k.check(await k.js(`ide.actions.find((a) => a.id === 'ShowUmlDiagram').title === '다이어그램 표시'`), 'action title in Korean');
  const leaks = await englishLeaks(k, '.dg-root');
  k.check(leaks.length === 0, `no English left in the diagram tab (${S(leaks)})`);
  await k.js(`(() => { const c = document.querySelector('.dg-canvas'); const r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.right - 4, clientY: r.bottom - 4 })); return true; })()`);
  await k.until(`document.querySelector('.context-menu')`, 'diagram menu');
  const menuLeaks = await englishLeaks(k, '.context-menu');
  k.check(menuLeaks.length === 0, `diagram context menu in Korean (${S(menuLeaks)})`);
  await k.press('Escape');
  const missing = (await missingTranslations(k)).filter((m) => /diagram|class|Field|Method|Private|Zoom|Fit|Export|files|Jump|Remove/i.test(m));
  k.check(missing.length === 0, `no missing translations (${S(missing)})`);
} catch (err) {
  k.check(false, err.message);
}
resC = k.results.filter((r) => !r.ok).length + k.consoleErrors.length;
console.log(`C: ${k.results.length - k.results.filter((r) => !r.ok).length}/${k.results.length} passed`);
if (k.consoleErrors.length) console.log(`renderer exceptions (C):\n  ${k.consoleErrors.join('\n  ')}`);
k.close();
}
const total = failures + resA + resB + resC;
console.log(total ? `FAILED (${total})` : 'ALL PASSED');
process.exit(total ? 1 : 0);
