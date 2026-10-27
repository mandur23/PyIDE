// Visual Scripting integration (renderer/features/visual-script/index.js, main/features/visual-script.js). Ports 9095-9099.
// With real CDP mouse and key input: Shift+F10, the Run menu, Rerun and the tab's Run button run a .pyflow through the
// Run tool window (Ask User answered on the console's stdin); a graph with a compile error refuses to run and selects
// the node; a division by zero marks its node and the traceback link selects it; Show Code follows edits and maps
// lines and nodes both ways; Export as Python writes a file that prints the same output and asks before overwriting,
// and asks for another name when <name>.py would hide a module; the generated file is <name>_pyflow.py, so random.pyflow
// importing random (indented, in a Python Code node) gets the real module;
// Project tree › New › Visual Script makes a working script; the file icon; readable labels at 100% in both themes;
// and a Korean session without English left in the tab, the palette and the dialogs.
import { readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import path from 'path';
import { createRequire } from 'module';
import { launch } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const S = JSON.stringify;
const require = createRequire(import.meta.url);
const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const VSDIR = path.join(APP, 'renderer', 'features', 'visual-script');
require(path.join(VSDIR, 'model.js'));
require(path.join(VSDIR, 'nodes.js'));
const VS = require(path.join(VSDIR, 'codegen.js'));

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
  const center = (selector) => js(`(() => { const n = document.querySelector(${S(selector)}); if (!n) return null; const r = n.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
  async function clickOn(selector, opts) {
    const p = await center(selector);
    if (!p) throw new Error(`nothing to click: ${selector}`);
    await click(p, opts);
  }
  // A canvas point with nothing under it, so a click there focuses the canvas without selecting anything.
  const emptySpot = () => js(`(() => { const c = document.querySelector('.vs-host:not(.hidden) .vs-canvas').getBoundingClientRect();
    for (let y = c.bottom - 30; y > c.top + 30; y -= 20) for (let x = c.left + 30; x < c.right - 30; x += 20) {
      const t = document.elementFromPoint(x, y);
      if (t && (t.classList.contains('vs-canvas') || t.classList.contains('vs-nodes')) && !document.elementsFromPoint(x, y).some((e) => e.closest?.('.vs-node, .vs-palette'))) return { x, y };
    }
    return null; })()`);
  // A menu row by its exact label at a menu level (0: the menu, 1: its submenu).
  const menuRow = (label, level = 0) => js(`(() => {
    const row = [...document.querySelectorAll('.context-menu[data-level="${level}"] .menu-item')].find((r) => r.firstChild.textContent === ${S(label)});
    if (!row) return null; const r = row.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);
  return { mouse, move, click, clickOn, center, emptySpot, menuRow };
}

const V = 'ide.activeTab().visualScript';
const sha1 = (p) => createHash('sha1').update(path.resolve(p).toLowerCase()).digest('hex');
// The program's own output in the Run console: what it printed, without the command line, the echoed stdin lines and
// the exit line.
const programOutput = `[...document.querySelectorAll('#runOut > span')].filter((s) => !s.classList.contains('cmd') && !s.classList.contains('sys')).map((s) => s.textContent).join('').replace(/\\r\\n/g, '\\n')`;
// The zoom a script opened at, its graph's size at 100% beside the canvas size, and whether every node is in view.
const viewInfo = `(() => { const h = document.querySelector('.vs-host:not(.hidden)'); const z = Number(h.dataset.zoom); const c = h.querySelector('.vs-canvas').getBoundingClientRect();
    const rs = [...h.querySelectorAll('.vs-node')].map((n) => n.getBoundingClientRect());
    const w = (Math.max(...rs.map((r) => r.right)) - Math.min(...rs.map((r) => r.left))) / z; const ht = (Math.max(...rs.map((r) => r.bottom)) - Math.min(...rs.map((r) => r.top))) / z;
    const inside = rs.every((r) => r.left >= c.left && r.right <= c.right && r.top >= c.top && r.bottom <= c.bottom);
    return { zoom: z, graph: [Math.round(w), Math.round(ht)], canvas: [Math.round(c.width), Math.round(c.height)], inside }; })()`;
const runText = `(document.querySelector('#runOut')?.textContent || '')`;
// `--viewport=1008x681` gives the window the inner size it has on CI's 1024x768 screen.
const viewport = process.argv.find((a) => a.startsWith('--viewport='))?.slice(11).split('x').map(Number);
async function sized(ctx) {
  if (!viewport) return ctx;
  await ctx.cdp('Emulation.setDeviceMetricsOverride', { width: viewport[0], height: viewport[1], deviceScaleFactor: 1, mobile: false });
  await ctx.until(`Math.abs(innerWidth - ${viewport[0]}) <= 1 && Math.abs(innerHeight - ${viewport[1]}) <= 1`, 'the emulated viewport');
  return ctx;
}

async function openScript(ctx, name) {
  await ctx.js(`ide.openFile(ide.util.joinPath(ide.root, ${S(name)}))`);
  await ctx.until(`ide.activeTab()?.path.toLowerCase().endsWith(${S(`\\${name}`.toLowerCase())}) && !!${V}?.graph() && !!document.querySelector('.vs-host:not(.hidden) .vs-node')`, `${name} on the canvas`);
}
async function focusCanvas(ctx, ui) {
  const spot = await ui.emptySpot();
  await ui.click(spot);
  await ctx.until(`document.activeElement?.classList.contains('vs-canvas')`, 'the canvas has the keyboard');
}
async function answer(ctx, ui, text) {
  await ctx.until(`!document.querySelector('#runIn')?.disabled`, 'the Run console takes input');
  await ui.clickOn('#runIn');
  await ctx.type(text);
  await ctx.press('Enter');
}

// WCAG contrast of two computed CSS colours (rgb(), rgba() or color(srgb ...)).
const contrastOf = `(fg, bg) => {
  const rgb = (c) => { const m = c.match(/color\\(srgb ([\\d.]+) ([\\d.]+) ([\\d.]+)/); if (m) return m.slice(1, 4).map((v) => +v * 255); return c.match(/[\\d.]+/g).slice(0, 3).map(Number); };
  const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}`;
// The smallest on-screen size and contrast of the node text at the current zoom: titles on their header, labels and
// field text on the node.
const readability = `(() => {
  const contrast = ${contrastOf};
  const host = document.querySelector('.vs-host:not(.hidden)');
  const zoom = Number(host.dataset.zoom);
  const out = { zoom, minPx: Infinity, minContrast: Infinity, worst: '' };
  const bgOf = (n) => { for (let e = n; e; e = e.parentElement) { const b = getComputedStyle(e).backgroundColor; if (b && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(b)) return b; } return 'rgb(0, 0, 0)'; };
  for (const n of host.querySelectorAll('.vs-node:not(.vs-comment) .vs-title, .vs-node .vs-label, .vs-node .vs-prop-name, .vs-node .vs-field, .vs-comment-text')) {
    const st = getComputedStyle(n);
    const px = parseFloat(st.fontSize) * zoom;
    const c = contrast(st.color, bgOf(n));
    if (px < out.minPx) out.minPx = px;
    if (c < out.minContrast) { out.minContrast = c; out.worst = n.className + ' ' + st.color + ' on ' + bgOf(n); }
  }
  return out;
})()`;

const ctx = await sized(await launch({ fixture: 'visual-script', port: 9095, name: 'visual-script' }));
const { js, until, press, type, shot, check, sleep, project } = ctx;
// The generated file is named by its long path (CI's TEMP is an 8.3 short path).
const userData = realpathSync.native(ctx.userData);
const ui = inputs(ctx);
const interp = await js(`(() => { const i = ide.currentInterp(); return i && { cmd: i.cmd, args: i.args }; })()`);
try {
  check(!!interp, `a Python interpreter is selected (${interp?.cmd} ${interp?.args?.join(' ')})`);

  await until(`[...document.querySelectorAll('#tree .node .name')].some((n) => n.textContent === 'demo.pyflow')`, 'tree lists demo.pyflow');
  const icon = await js(`(() => { const row = [...document.querySelectorAll('#tree .node')].find((n) => n.querySelector('.name').textContent === 'demo.pyflow'); const i = row.querySelector('.file-icon'); return { type: i.dataset.type, svg: [...i.querySelectorAll('svg')].filter((s) => s.getBoundingClientRect().width > 0).length }; })()`);
  check(icon.type === 'nodeGraph' && icon.svg === 1, `a .pyflow file shows the node-graph icon in the project tree (${S(icon)})`);

  await openScript(ctx, 'demo.pyflow');
  const toolbar = await js(`[...document.querySelectorAll('.vs-host:not(.hidden) .vs-toolbar-slot .vs-btn')].map((b) => b.textContent.trim())`);
  check(S(toolbar) === S(['Run', 'Show Code', 'Export as Python…']), `the tab toolbar has Run, Show Code and Export as Python… (${S(toolbar)})`);
  await sleep(300);
  const demoFirst = await js(viewInfo);
  const demoFits = demoFirst.graph[0] <= demoFirst.canvas[0] - 32 && demoFirst.graph[1] <= demoFirst.canvas[1] - 32;
  check(demoFits ? demoFirst.zoom === 1 : demoFirst.zoom < 1 && demoFirst.inside, `demo.pyflow opens at 100% when it fits and is fitted when it does not (${S({ ...demoFirst, fits: demoFits })})`);
  check(/^Run 'demo' \(Ctrl\+Shift\+F10\)$/.test(await js(`document.querySelector('.vs-host:not(.hidden) .vs-run').title`)), 'the Run button says what it runs and its shortcut');

  // ---- Run with Shift+F10, answer Ask User on stdin ----
  await focusCanvas(ctx, ui);
  await press('Shift+F10');
  await until(`${runText}.includes('What is your name?')`, 'the program asks for a name in the Run console', 30000);
  check(await js(`document.querySelector('.run-tab.active .run-tab-title')?.textContent`) === 'demo', 'the Run tab is titled with the script name');
  const demoPath = await js(`ide.activeTab().path`);
  const generated = path.join(userData, 'visual-script', sha1(demoPath), 'demo_pyflow.py');
  check(existsSync(generated), `the code is written to <userData>/visual-script/<sha1 of the path>/demo_pyflow.py`);
  check(await js(`${runText}.split('\\n')[0].includes(${S(generated)})`), 'the console shows the command that runs the generated file');
  await answer(ctx, ui, 'Ada');
  await until(`${runText}.includes('Process finished with exit code 0')`, 'the run finishes', 30000);
  const out1 = await js(programOutput);
  check(out1 === 'What is your name? Hello Ada!\n0\n10\n20\nDone\n', `Shift+F10 runs the graph with the answer typed on stdin (${S(out1)})`);
  const generatedCode = readFileSync(generated, 'utf8');
  const demoGraph = VS.parse(readFileSync(path.join(project, 'demo.pyflow'), 'utf8'));
  check(generatedCode === VS.compile(demoGraph, { fileName: 'demo.pyflow' }).code, 'the generated file is VS.compile of the script');

  // ---- Rerun from the Run tool window ----
  await ui.clickOn(`button[title^="Rerun 'demo'"]`);
  await until(`${runText}.includes('What is your name?') && !${runText}.includes('Hello Ada')`, 'Rerun starts the script again in the same tab', 30000);
  await answer(ctx, ui, 'Bob');
  await until(`${runText}.includes('Process finished with exit code 0')`, 'the rerun finishes', 30000);
  check(await js(programOutput) === 'What is your name? Hello Bob!\n0\n10\n20\nDone\n', 'Rerun runs the script again');
  check(await js(`document.querySelectorAll('.run-tab').length`) === 1, 'Rerun reuses the Run tab');

  // ---- Run › Run from the main menu ----
  await ui.clickOn('#mainMenuBtn');
  await until(`!!document.querySelector('.context-menu[data-level="0"]')`, 'main menu');
  await ui.move(await ui.menuRow('Run', 0));
  await until(`!!document.querySelector('.context-menu[data-level="1"]')`, 'Run submenu');
  await ui.click(await ui.menuRow('Run', 1));
  await until(`${runText}.includes('What is your name?') && !${runText}.includes('Hello Bob')`, 'Run › Run starts the active .pyflow', 30000);
  await answer(ctx, ui, '세종');
  await until(`${runText}.includes('Process finished with exit code 0')`, 'the menu run finishes', 30000);
  check(await js(programOutput) === 'What is your name? Hello 세종!\n0\n10\n20\nDone\n', 'Run › Run in the main menu runs the active script (Korean input and output intact)');

  // ---- a compile error refuses to run and selects the node ----
  await openScript(ctx, 'problem.pyflow');
  await focusCanvas(ctx, ui);
  await press('Shift+F10');
  await until(`${runText}.includes('Fix the problems in problem.pyflow before running it:')`, 'the Run console says why it did not run');
  await sleep(300);
  check(await js(`${runText}.includes('Get Variable (n3): No Set Variable stores a value named "missing".')`), 'the console lists the problem with its node');
  const started = await js(`({ finished: ${runText}.includes('Process finished'), running: ide.run.activeSession().running, launched: ide.run.activeSession().launched })`);
  check(!started.finished && !started.running && !started.launched, `no process was started (${S(started)})`);
  check(!existsSync(path.join(userData, 'visual-script', sha1(await js(`ide.activeTab().path`)))), 'no code was written for a script with errors');
  check(await js(`${V}.selection().join(',')`) === 'n3', 'the node in error is selected');
  check(await js(`document.querySelector('.vs-host:not(.hidden) .vs-node[data-id="n3"]').classList.contains('vs-err')`), 'the node in error is outlined');

  // ---- a runtime error marks its node; the traceback link selects it ----
  await openScript(ctx, 'zero.pyflow');
  await sleep(300);
  const firstView = await js(viewInfo);
  const zeroFits = firstView.graph[0] <= firstView.canvas[0] - 32 && firstView.graph[1] <= firstView.canvas[1] - 32;
  check(zeroFits ? firstView.zoom === 1 : firstView.zoom < 1 && firstView.inside, `the first time, a graph that fits the canvas opens at 100% and a bigger one is fitted into it (${S({ ...firstView, fits: zeroFits })})`);
  await focusCanvas(ctx, ui);
  await press('Shift+F10');
  await until(`${runText}.includes('Process finished with exit code 1')`, 'the failing script ends', 30000);
  await until(`document.querySelector('.vs-host:not(.hidden) .vs-node[data-id="n3"]')?.classList.contains('vs-runtime-err')`, 'the node that divided by zero is marked');
  check(await js(`document.querySelector('.vs-host:not(.hidden) .vs-node[data-id="n3"] .vs-runtime')?.textContent`) === 'ZeroDivisionError: division by zero', 'the mark shows the exception line');
  check(await js(`document.querySelectorAll('.vs-host:not(.hidden) .vs-runtime-err').length`) === 1, 'only that node is marked');
  const zeroOut = await js(programOutput);
  check(zeroOut.startsWith('Start\nTraceback') && !zeroOut.includes('never'), 'the steps before the error ran and the ones after did not');
  const zeroPy = path.join(userData, 'visual-script', sha1(await js(`ide.activeTab().path`)), 'zero_pyflow.py');
  await openScript(ctx, 'demo.pyflow');
  const link = `[...document.querySelectorAll('#runOut a')].find((a) => a.textContent === ${S(`File "${zeroPy}", line 6`)})`;
  check(await js(`!!${link}`), 'the traceback line in the generated file is a link');
  check(await js(`${link}.title`) === 'Show the node in zero.pyflow', 'the link says it shows the node');
  // The tab just switched, so the Run window may still be settling: the link is clicked once it stays put.
  const linkPoint = () => js(`(() => { const a = ${link}; a.scrollIntoView({ block: 'center' }); const r = a.getClientRects()[0]; return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  let linkAt = await linkPoint();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const again = await linkPoint();
    if (S(again) === S(linkAt)) break;
    linkAt = again;
  }
  await ui.click(linkAt);
  await until(`ide.activeTab()?.path.toLowerCase().endsWith('\\\\zero.pyflow')`, 'the link opens the .pyflow tab');
  await until(`${V}.selection().join(',') === 'n3'`, 'the link selects the node');
  check(!(await js(`ide.groups().flatMap((g) => g.tabs).some((t) => /zero_pyflow\\.py$/i.test(t.path))`)), 'the generated file is not opened');
  check(await js(`(() => { const n = document.querySelector('.vs-host:not(.hidden) .vs-node[data-id="n3"]').getBoundingClientRect(); const c = document.querySelector('.vs-host:not(.hidden) .vs-canvas').getBoundingClientRect(); return n.left >= c.left && n.right <= c.right && n.top >= c.top && n.bottom <= c.bottom; })()`), 'the node is brought into view');
  await shot('runtime-error.png');

  // ---- a script named like the module it imports ----
  let mathGraph = VS.newGraph();
  mathGraph = VS.addNode(mathGraph, { id: 'n2', type: 'py.call', x: 320, y: 112 });
  mathGraph = VS.setInputLiteral(mathGraph, 'n2', 'arg0', 16);
  mathGraph = VS.addNode(mathGraph, { id: 'n3', type: 'io.print', x: 640, y: 112 });
  mathGraph = VS.connect(mathGraph, { node: 'n1', pin: 'next' }, { node: 'n2', pin: 'in' });
  mathGraph = VS.connect(mathGraph, { node: 'n2', pin: 'next' }, { node: 'n3', pin: 'in' });
  mathGraph = VS.connect(mathGraph, { node: 'n2', pin: 'result' }, { node: 'n3', pin: 'value' });
  writeFileSync(path.join(project, 'math.pyflow'), VS.serialize(mathGraph));
  await openScript(ctx, 'math.pyflow');
  await focusCanvas(ctx, ui);
  await press('Shift+F10');
  await until(`${runText}.includes('Process finished with exit code')`, 'math.pyflow ends', 30000);
  check(await js(programOutput) === '4.0\n', `math.pyflow calling math.sqrt runs as math_pyflow.py instead of importing itself (${S(await js(programOutput))})`);

  // random.pyflow importing random inside main() (a Python Code node), with a random.py an older version left in the
  // generated file's folder.
  let randomGraph = VS.newGraph();
  randomGraph = VS.addNode(randomGraph, { id: 'n2', type: 'py.code', x: 320, y: 112, props: { code: 'import random\nrandom.seed(7)\nprint(random.randint(5, 5))', inputs: '' } });
  randomGraph = VS.connect(randomGraph, { node: 'n1', pin: 'next' }, { node: 'n2', pin: 'in' });
  const randomPath = path.join(project, 'random.pyflow');
  writeFileSync(randomPath, VS.serialize(randomGraph));
  const randomDir = path.join(userData, 'visual-script', sha1(await js(`ide.util.joinPath(ide.root, 'random.pyflow')`)));
  mkdirSync(randomDir, { recursive: true });
  writeFileSync(path.join(randomDir, 'random.py'), 'raise SystemExit("the stale random.py was imported")\n');
  await openScript(ctx, 'random.pyflow');
  await focusCanvas(ctx, ui);
  await press('Shift+F10');
  await until(`${runText}.includes('Process finished with exit code')`, 'random.pyflow ends', 30000);
  check(await js(programOutput) === '5\n' && existsSync(path.join(randomDir, 'random_pyflow.py')) && !existsSync(path.join(randomDir, 'random.py')),
    `random.pyflow with an indented import random runs as random_pyflow.py, and an old random.py beside it is removed (${S(await js(programOutput))})`);

  // Export: random.py beside the script would hide the module (standard, and imported by the script).
  await ui.clickOn('.vs-host:not(.hidden) .vs-export');
  await until(`!!document.querySelector('#dialogHost .dialog .vs-export-input')`, 'Export asks for another name');
  const shadowText = await js(`document.querySelector('#dialogHost .dialog').textContent`);
  const suggested = await js(`document.querySelector('#dialogHost .vs-export-input').value`);
  check(shadowText.includes('random.py would hide the Python module random') && suggested === 'random_script.py' && await js(`document.activeElement?.classList.contains('vs-export-input')`),
    `Export of random.pyflow warns that random.py would hide the module and suggests random_script.py, focused (${S(shadowText)})`);
  await press('Ctrl+a');
  await type('json');
  await press('Enter');
  await sleep(300);
  check(await js(`document.querySelector('#dialogHost .vs-export-input')?.classList.contains('vs-invalid') && document.querySelector('#dialogHost .dialog').textContent.includes('json.py would hide the Python module json')`),
    'a name that hides another module (json) is refused in the same dialog');
  check(!existsSync(path.join(project, 'json.py')) && !existsSync(path.join(project, 'random.py')), 'nothing is written while the name hides a module');
  await press('Ctrl+a');
  await type('dice.py');
  await press('Enter');
  await until(`ide.activeTab()?.path.toLowerCase().endsWith('\\\\dice.py')`, 'Export writes and opens dice.py');
  const dice = spawnSync(interp.cmd, [...interp.args, path.join(project, 'dice.py')], { encoding: 'utf8', cwd: project });
  check(dice.status === 0 && dice.stdout.trim() === '5' && !existsSync(path.join(project, 'random.py')), `the exported dice.py runs and prints 5 (${S(dice.stdout + dice.stderr)})`);
  await js(`ide.closeTab(ide.activeTab().path, true)`);
  await openScript(ctx, 'random.pyflow');
  await ui.clickOn('.vs-host:not(.hidden) .vs-export');
  await until(`!!document.querySelector('#dialogHost .dialog .vs-export-input')`, 'the name question again');
  await press('Escape');
  await until(`!document.querySelector('#dialogHost .dialog')`, 'Escape cancels');
  check(!existsSync(path.join(project, 'random_script.py')) && !existsSync(path.join(project, 'random.py')), 'cancelling the name question exports nothing');

  // ---- Show Code ----
  await openScript(ctx, 'demo.pyflow');
  await ui.clickOn('.vs-host:not(.hidden) .vs-show-code');
  await until(`!document.querySelector('.vs-host:not(.hidden) .vs-side').classList.contains('hidden') && !!${V}.codePane()?.editor.getModel().getValue()`, 'Show Code opens the code pane');
  const code = `${V}.codePane().editor.getModel().getValue()`;
  const compiled = `PyideVisualScript.compile(${V}.graph(), { fileName: 'demo.pyflow' })`;
  check(await js(`${code} === ${compiled}.code`), 'the pane shows the generated Python');
  check(await js(`${V}.codePane().editor.getOption(ide.monaco.editor.EditorOption.readOnly)`), 'the code pane is read-only');
  check(await js(`document.querySelector('.vs-host:not(.hidden) .vs-show-code').getAttribute('aria-pressed')`) === 'true', 'Show Code is drawn pressed');

  await ui.clickOn('.vs-host:not(.hidden) .vs-node[data-id="n4"] .vs-head');
  await until(`${V}.selection().join(',') === 'n4'`, 'n4 selected');
  const n4Lines = await js(`${compiled}.map.flatMap((id, line) => (id === 'n4' ? [line] : [])).join(',')`);
  await until(`document.querySelector('.vs-host:not(.hidden) .vs-side').dataset.lines === ${S(n4Lines)}`, 'the selected node\'s lines are highlighted');
  check(n4Lines && await js(`document.querySelectorAll('.vs-host:not(.hidden) .vs-code .vs-code-sel').length`) === n4Lines.split(',').length, `selecting a node highlights its lines (${n4Lines})`);

  const n6Line = await js(`${code}.split('\\n').findIndex((l) => l.includes('print(index_n5 * 10)')) + 1`);
  const lineAt = await js(`(() => { const ed = ${V}.codePane().editor; const p = ed.getScrolledVisiblePosition({ lineNumber: ${n6Line}, column: 6 }); const r = ed.getDomNode().getBoundingClientRect(); return { x: r.left + p.left + 4, y: r.top + p.top + p.height / 2 }; })()`);
  await ui.click(lineAt);
  await until(`${V}.selection().join(',') === 'n6'`, 'clicking a code line selects its node');
  check(true, `clicking line ${n6Line} of the code selects its node (n6)`);

  const n2Line = await js(`${code}.split('\\n').findIndex((l) => l.includes('answer_n2 = input(')) + 1`);
  await ui.click(await js(`(() => { const ed = ${V}.codePane().editor; const p = ed.getScrolledVisiblePosition({ lineNumber: ${n2Line}, column: 6 }); const r = ed.getDomNode().getBoundingClientRect(); return { x: r.left + p.left + 4, y: r.top + p.top + p.height / 2 }; })()`));
  await until(`${V}.selection().join(',') === 'n2'`, 'clicking the input() line selects Ask User and brings it into view');
  const promptField = '.vs-host:not(.hidden) .vs-node[data-id="n2"] input.vs-field';
  await ui.clickOn(promptField);
  await press('Ctrl+a');
  await type('Your name? ');
  await press('Enter');
  await until(`${code}.includes('input("Your name? ")')`, 'the code follows an edit on the canvas').catch(async (err) => {
    throw new Error(`${err.message}: ${S(await js(`({ field: document.querySelector(${S(promptField)}).value, stored: ${V}.graph().nodes.find((n) => n.id === 'n2').inputs, active: document.activeElement?.className })`))}`);
  });
  check(await js(`${code} === ${compiled}.code`), 'after an edit the pane still equals the compiled graph');
  await focusCanvas(ctx, ui);
  await press('Ctrl+z');
  await until(`${code}.includes('input("What is your name? ")')`, 'the code follows undo');
  check(!(await js(`ide.isDirty(ide.activeTab())`)), 'undo brings the script back to its saved text');

  await js(`ide.closeTab(ide.activeTab().path, true)`);
  await openScript(ctx, 'demo.pyflow');
  await until(`!document.querySelector('.vs-host:not(.hidden) .vs-side').classList.contains('hidden')`, 'Show Code is remembered when the script opens again');
  await shot('show-code.png');
  await ui.clickOn('.vs-host:not(.hidden) .vs-show-code');
  await until(`document.querySelector('.vs-host:not(.hidden) .vs-side').classList.contains('hidden')`, 'Show Code toggles the pane off');

  // ---- Export as Python ----
  const exported = path.join(project, 'demo.py');
  await ui.clickOn('.vs-host:not(.hidden) .vs-export');
  await until(`ide.activeTab()?.path.toLowerCase().endsWith('\\\\demo.py')`, 'Export opens demo.py');
  check(readFileSync(exported, 'utf8').replace(/\r\n/g, '\n') === VS.compile(demoGraph, { fileName: 'demo.pyflow' }).code, 'Export as Python writes the generated code next to the script');
  const ran = spawnSync(interp.cmd, [...interp.args, exported], { input: 'Ada\n', encoding: 'utf8', cwd: project, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  check(ran.status === 0 && ran.stdout.replace(/\r\n/g, '\n') === out1, `the exported file runs and prints what the IDE run printed (${S(ran.stdout)}${ran.stderr ? ` ${ran.stderr}` : ''})`);

  await js(`ide.closeTab(ide.activeTab().path, true)`);
  writeFileSync(exported, '# mine\n');
  await openScript(ctx, 'demo.pyflow');
  await ui.clickOn('.vs-host:not(.hidden) .vs-export');
  await until(`document.querySelector('#dialogHost .dialog')?.textContent.includes('demo.py already exists. Overwrite it?')`, 'Export asks before overwriting');
  const dialogText = await js(`document.querySelector('#dialogHost .dialog').textContent`);
  check(dialogText.includes('Export as Python') && dialogText.includes('Overwrite') && dialogText.includes('Cancel'), 'the question has Overwrite and Cancel');
  await ui.clickOn('#dialogHost .dialog button.secondary');
  await until(`!document.querySelector('#dialogHost .dialog')`, 'Cancel closes the question');
  await sleep(300);
  check(readFileSync(exported, 'utf8') === '# mine\n' && (await js(`ide.activeTab().path`)).endsWith('demo.pyflow'), 'Cancel leaves the existing file alone');
  await ui.clickOn('.vs-host:not(.hidden) .vs-export');
  await until(`!!document.querySelector('#dialogHost .dialog button.primary')`, 'the question again');
  await ui.clickOn('#dialogHost .dialog button.primary');
  await until(`ide.activeTab()?.path.toLowerCase().endsWith('\\\\demo.py')`, 'Overwrite opens demo.py');
  check(readFileSync(exported, 'utf8').replace(/\r\n/g, '\n') === VS.compile(demoGraph, { fileName: 'demo.pyflow' }).code, 'Overwrite replaces the file with the code');
  await js(`ide.closeTab(ide.activeTab().path, true)`);

  // ---- New › Visual Script, the tab's Run button, and a small graph at 100% ----
  const rootRow = await ui.center('#tree .node');
  await ui.click(rootRow, { button: 'right' });
  await until(`!!document.querySelector('.context-menu[data-level="0"]')`, 'tree context menu');
  await ui.move(await ui.menuRow('New', 0));
  await until(`!!document.querySelector('.context-menu[data-level="1"]')`, 'New submenu');
  const newItems = await js(`[...document.querySelectorAll('.context-menu[data-level="1"] .menu-item')].map((r) => r.firstChild.textContent)`);
  check(newItems.indexOf('Visual Script') === newItems.indexOf('Python Package') + 1 && newItems.indexOf('Python Package') >= 0, `New › lists Visual Script after Python Package (${S(newItems)})`);
  check(newItems.filter((l) => l === 'Visual Script').length === 1 && (await js(`[...document.querySelectorAll('.context-menu[data-level="0"] .menu-item')].filter((r) => r.firstChild.textContent === 'New').length`)) === 1, 'there is one New › menu with one Visual Script item');
  await ui.click(await ui.menuRow('Visual Script', 1));
  await until(`!document.querySelector('#popup').classList.contains('hidden')`, 'the name prompt');
  check((await js(`document.querySelector('#popupIn').placeholder`)) === 'New visual script name', 'the prompt asks for the script name');
  await type('hello');
  await press('Enter');
  await until(`ide.activeTab()?.path.toLowerCase().endsWith('\\\\hello.pyflow') && !!${V}?.graph()`, 'the new script opens');
  const hello = VS.parse(readFileSync(path.join(project, 'hello.pyflow'), 'utf8'));
  check(hello.nodes.map((n) => n.type).join(',') === 'core.start,io.print' && hello.links.length === 1 && VS.compile(hello, {}).code.includes('print("Hello")'), 'the new script is Start wired to Print "Hello"');
  check(await js(`[...document.querySelectorAll('#tree .node .name')].some((n) => n.textContent === 'hello.pyflow')`), 'the tree shows the new script');
  await until(`document.querySelector('.vs-host:not(.hidden)').dataset.zoom === '1.000'`, 'the small graph opens at 100%');
  check(true, 'a graph that fits is not shrunk: the new script opens at 100%');
  await ui.clickOn('.vs-host:not(.hidden) .vs-run');
  await until(`${runText}.includes('Process finished with exit code 0')`, 'the tab Run button runs the new script', 30000);
  check(await js(programOutput) === 'Hello\n', 'the new script prints Hello from the tab\'s Run button');
  check(await js(`ide.run.selected()?.name`) === 'hello', 'the Run button selects the script\'s configuration in the run widget');
  await js(`(document.querySelector('#runOut').dataset.old = '1', true)`);
  await focusCanvas(ctx, ui);
  await press('Ctrl+Shift+F10');
  await until(`!document.querySelector('#runOut')?.dataset.old && ${runText}.includes('Process finished with exit code 0')`, 'Ctrl+Shift+F10 runs the script again', 30000);
  check(await js(programOutput) === 'Hello\n' && await js(`document.querySelector('.run-tab.active .run-tab-title')?.textContent`) === 'hello', 'Ctrl+Shift+F10 on the canvas runs the script as its context configuration');

  const dark = await js(readability);
  check(dark.minPx >= 12 && dark.minContrast >= 4.5, `node text at 100% is readable in the dark theme (smallest ${dark.minPx}px, contrast ${dark.minContrast.toFixed(2)}${dark.minContrast < 4.5 ? `: ${dark.worst}` : ''})`);
  await openScript(ctx, 'demo.pyflow');
  await js(`(${V}.setView({ s: 1 }), true)`);
  await until(`document.querySelector('.vs-host:not(.hidden)').dataset.zoom === '1.000'`, 'demo at 100%');
  const demoDark = await js(readability);
  check(demoDark.minPx >= 12 && demoDark.minContrast >= 4.5, `demo.pyflow at 100% in the dark theme: smallest ${demoDark.minPx}px, contrast ${demoDark.minContrast.toFixed(2)}${demoDark.minContrast < 4.5 ? ` (${demoDark.worst})` : ''}`);
  await shot('demo-100-dark.png');
  await js(`(ide.settings.set('appearance.theme', 'light'), true)`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'light theme');
  await sleep(200);
  const demoLight = await js(readability);
  check(demoLight.minPx >= 12 && demoLight.minContrast >= 4.5, `demo.pyflow at 100% in the light theme: smallest ${demoLight.minPx}px, contrast ${demoLight.minContrast.toFixed(2)}${demoLight.minContrast < 4.5 ? ` (${demoLight.worst})` : ''}`);
  await shot('demo-100-light.png');
  const lightIcon = await js(`(() => { const row = [...document.querySelectorAll('#tree .node')].find((n) => n.querySelector('.name').textContent === 'demo.pyflow'); return [...row.querySelectorAll('.file-icon svg')].find((s) => s.getBoundingClientRect().width > 0)?.querySelector('[stroke]')?.getAttribute('stroke'); })()`);
  check(lightIcon === '#3574F0', `the node-graph icon has a light-theme drawing (${lightIcon})`);
  await js(`(ide.settings.set('appearance.theme', 'dark'), true)`);

  check(ctx.consoleErrors.length === 0, `no renderer exceptions${ctx.consoleErrors.length ? ` ${S(ctx.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
  await shot('failure.png').catch(() => {});
}
ctx.close();

// ---- Korean ----
const randomKo = () => {
  const g = VS.addNode(VS.newGraph(), { id: 'n2', type: 'py.code', x: 320, y: 112, props: { code: 'import random', inputs: '' } });
  return VS.connect(g, { node: 'n1', pin: 'next' }, { node: 'n2', pin: 'in' });
};
const ko = await sized(await launch({ fixture: 'visual-script', port: 9096, name: 'visual-script-ko', lang: 'ko-KR' }));
const kui = inputs(ko);
try {
  await openScript(ko, 'demo.pyflow');
  await kui.clickOn('.vs-host:not(.hidden) .vs-show-code');
  await ko.until(`!!${V}.codePane()?.editor.getModel().getValue()`, 'code pane');
  const tabLeaks = await englishLeaks(ko, '.vs-host:not(.hidden)');
  ko.check(!tabLeaks.length, `the canvas tab (toolbar, nodes, code pane, status) has no English UI text${tabLeaks.length ? `: ${S(tabLeaks)}` : ''}`);
  const labels = await ko.js(`[...document.querySelectorAll('.vs-host:not(.hidden) .vs-toolbar-slot .vs-btn')].map((b) => b.textContent.trim())`);
  ko.check(S(labels) === S(['실행', '코드 표시', 'Python으로 내보내기…']), `the tab buttons are Korean (${S(labels)})`);

  await focusCanvas(ko, kui);
  await ko.press('Tab');
  await ko.until(`!!document.querySelector('.vs-host:not(.hidden) .vs-palette')`, 'palette');
  const palLeaks = await englishLeaks(ko, '.vs-host:not(.hidden) .vs-palette');
  ko.check(!palLeaks.length, `the palette has no English UI text${palLeaks.length ? `: ${S(palLeaks.slice(0, 8))}` : ''}`);
  await ko.type('출력');
  await ko.until(`document.querySelector('.vs-palette .vs-pal-item.vs-active .vs-pal-title')?.textContent === '출력 (print)'`, 'typing 출력 finds Print');
  ko.check(true, 'typing 출력 in the palette finds Print (출력 (print))');
  await ko.press('Escape');
  for (const [query, type, title] of [['입력', 'io.input', '사용자에게 묻기 (input)'], ['input', 'io.input', '사용자에게 묻기 (input)'], ['print', 'io.print', '출력 (print)']]) {
    await ko.press('Tab');
    await ko.until(`!!document.querySelector('.vs-host:not(.hidden) .vs-palette')`, 'palette');
    await ko.type(query);
    await ko.until(`document.querySelector('.vs-palette .vs-pal-item')?.dataset.type === ${S(type)} && document.querySelector('.vs-palette .vs-pal-item.vs-active')?.dataset.type === ${S(type)}`, `typing ${query} puts ${type} first`)
      .catch(async (err) => { throw new Error(`${err.message}: ${S(await ko.js(`[...document.querySelectorAll('.vs-palette .vs-pal-item')].slice(0, 4).map((r) => r.textContent)`))}`); });
    ko.check(true, `typing ${query} in the Korean palette puts ${title} first, so Enter adds it`);
    await ko.press('Escape');
  }

  await ko.press('Shift+F10');
  await ko.until(`(document.querySelector('#runOut')?.textContent || '').includes('What is your name?')`, 'Korean run asks', 30000);
  await answer(ko, kui, '하나');
  await ko.until(`(document.querySelector('#runOut')?.textContent || '').includes('종료 코드 0')`, 'Korean run finishes', 30000);
  ko.check(await ko.js(programOutput) === 'What is your name? Hello 하나!\n0\n10\n20\nDone\n', 'the run works in the Korean session');

  await kui.clickOn('.vs-host:not(.hidden) .vs-export');
  await ko.until(`ide.activeTab()?.path.toLowerCase().endsWith('\\\\demo.py')`, 'export in Korean');
  await ko.js(`ide.closeTab(ide.activeTab().path, true)`);
  await openScript(ko, 'demo.pyflow');
  await kui.clickOn('.vs-host:not(.hidden) .vs-export');
  await ko.until(`!!document.querySelector('#dialogHost .dialog')`, 'overwrite question in Korean');
  const dlgLeaks = await englishLeaks(ko, '#dialogHost');
  const dlgText = await ko.js(`document.querySelector('#dialogHost .dialog').textContent`);
  ko.check(!dlgLeaks.length && dlgText.includes('demo.py이(가) 이미 있습니다. 덮어쓸까요?') && dlgText.includes('덮어쓰기'), `the overwrite question is Korean (${S(dlgText)}${dlgLeaks.length ? ` leaks ${S(dlgLeaks)}` : ''})`);
  await kui.clickOn('#dialogHost .dialog button.secondary');
  await ko.until(`!document.querySelector('#dialogHost .dialog')`, 'cancelled');

  writeFileSync(path.join(ko.project, 'random.pyflow'), VS.serialize(randomKo()));
  await openScript(ko, 'random.pyflow');
  await kui.clickOn('.vs-host:not(.hidden) .vs-export');
  await ko.until(`!!document.querySelector('#dialogHost .dialog .vs-export-input')`, 'the export name question in Korean');
  const nameLeaks = await englishLeaks(ko, '#dialogHost');
  const nameText = await ko.js(`document.querySelector('#dialogHost .dialog').textContent`);
  ko.check(!nameLeaks.length && nameText.includes('random.py은(는) Python 모듈 random을(를) 가립니다') && nameText.includes('내보내기'), `the export name question is Korean (${S(nameText)}${nameLeaks.length ? ` leaks ${S(nameLeaks)}` : ''})`);
  await ko.press('Escape');
  await ko.until(`!document.querySelector('#dialogHost .dialog')`, 'closed');

  await openScript(ko, 'problem.pyflow');
  await focusCanvas(ko, kui);
  await ko.press('Shift+F10');
  await ko.until(`(document.querySelector('#runOut')?.textContent || '').includes('실행하기 전에 problem.pyflow의 문제를 수정하세요:')`, 'the refusal is Korean');
  ko.check(true, 'a script with problems is refused in Korean');

  await kui.click(await kui.center('#tree .node'), { button: 'right' });
  await ko.until(`!!document.querySelector('.context-menu[data-level="0"]')`, 'tree menu');
  await kui.move(await kui.menuRow('새로 만들기', 0));
  await ko.until(`!!document.querySelector('.context-menu[data-level="1"]')`, 'New submenu');
  const menuLeaks = await englishLeaks(ko, '.context-menu');
  ko.check(!menuLeaks.length && await ko.js(`[...document.querySelectorAll('.context-menu[data-level="1"] .menu-item')].some((r) => r.firstChild.textContent === '비주얼 스크립트')`), `New › 비주얼 스크립트 in Korean${menuLeaks.length ? `: ${S(menuLeaks)}` : ''}`);
  await kui.click(await kui.menuRow('비주얼 스크립트', 1));
  await ko.until(`!document.querySelector('#popup').classList.contains('hidden')`, 'name prompt');
  ko.check(await ko.js(`document.querySelector('#popupIn').placeholder`) === '새 비주얼 스크립트 이름', 'the name prompt is Korean');
  await ko.type('인사');
  await ko.press('Enter');
  await ko.until(`ide.activeTab()?.path.endsWith('\\\\인사.pyflow') && !!${V}?.graph()`, 'a script with a Korean name opens');
  await kui.clickOn('.vs-host:not(.hidden) .vs-run');
  await ko.until(`(document.querySelector('#runOut')?.textContent || '').includes('종료 코드 0')`, 'the Korean-named script runs', 30000);
  ko.check(await ko.js(programOutput) === 'Hello\n', 'a script named 인사.pyflow runs');

  await ko.js(`(ide.run.editConfigurations(), true)`);
  await ko.until(`!!document.querySelector('#dialogHost .rc-form')`, 'Edit Configurations');
  const rcLeaks = await englishLeaks(ko, '#dialogHost');
  const rcForm = await ko.js(`document.querySelector('#dialogHost .rc-form').textContent`);
  ko.check(!rcLeaks.length && rcForm.includes('비주얼 스크립트'), `the Visual Script configuration form is Korean${rcLeaks.length ? `: ${S(rcLeaks)}` : ''}`);
  await ko.press('Escape');

  const missing = await missingTranslations(ko);
  ko.check(!missing.length, `every tr() string shown has a Korean entry${missing.length ? `: ${S(missing)}` : ''}`);
  await ko.shot('korean.png');
  ko.check(ko.consoleErrors.length === 0, `no renderer exceptions${ko.consoleErrors.length ? ` ${S(ko.consoleErrors)}` : ''}`);
} catch (err) {
  ko.check(false, err.message);
  await ko.shot('failure.png').catch(() => {});
}
for (const r of ko.results) ctx.results.push(r);
ko.close();
ctx.consoleErrors.push(...ko.consoleErrors);
ctx.finish();
