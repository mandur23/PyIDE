// Debugging visual scripts on their nodes (renderer/features/visual-script/debug.js, the debugger's generated-source
// hook). Ports 9082-9085. With real CDP mouse and key input: F9, Ctrl+F8, the header dot and the node menu toggle
// breakpoints on steps (not on pure nodes); Shift+F9 pauses on a breakpoint in a loop with the node outlined, the loop
// index in Variables named after its node (the generated name in the tooltip and usable in a watch; Set Variable names
// as they are) and on hover over a pin and a wire (the bubble beside the node, never over the paused node's
// title); Python Expression is never evaluated again; Step Over moves the outline; Resume runs to the next hit; a condition limits hits; a breakpoint removed while paused stops pausing;
// Step Into a project function opens its .py and Step Out comes back to the node; Frames name the .pyflow; Rerun
// compiles the graph again; an uncaught exception marks its node; a graph calling a src-layout module runs and steps
// into it; the changed-signature row's style in both themes; breakpoints survive a restart; Korean.
import { readFileSync } from 'fs';
import path from 'path';
import { launch } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const S = JSON.stringify;
const HOST = '.vs-host:not(.hidden)';
const V = 'ide.activeTab().visualScript';
const node = (id) => `${HOST} .vs-node[data-id="${id}"]`;
const pin = (id, side, p) => `${node(id)} .vs-pin[data-side="${side}"][data-pin="${p}"]`;
const BUTTONS = { left: 1, right: 2, middle: 4 };
// WCAG contrast of two computed CSS colours (rgb(), rgba() or color(srgb ...)).
const contrastOf = `(fg, bg) => {
  const rgb = (c) => { const m = c.match(/color\\(srgb ([\\d.]+) ([\\d.]+) ([\\d.]+)/); if (m) return m.slice(1, 4).map((v) => +v * 255); return c.match(/[\\d.]+/g).slice(0, 3).map(Number); };
  const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}`;

// `--viewport=1008x681` gives the window the inner size it has on CI's 1024x768 screen.
const viewport = process.argv.find((a) => a.startsWith('--viewport='))?.slice(11).split('x').map(Number);
async function sized(ctx) {
  if (!viewport) return ctx;
  await ctx.cdp('Emulation.setDeviceMetricsOverride', { width: viewport[0], height: viewport[1], deviceScaleFactor: 1, mobile: false });
  await ctx.until(`Math.abs(innerWidth - ${viewport[0]}) <= 1 && Math.abs(innerHeight - ${viewport[1]}) <= 1`, 'the emulated viewport');
  return ctx;
}

function inputs(ctx) {
  const { cdp, sleep, js } = ctx;
  const mouse = (type, p, { button = 'left', pressed = button } = {}) => cdp('Input.dispatchMouseEvent', {
    type, x: p.x, y: p.y, button: type === 'mouseMoved' && !pressed ? 'none' : button, buttons: type === 'mouseReleased' || !pressed ? 0 : BUTTONS[button], clickCount: 1,
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
  // A point on a node's title, away from its pins and its breakpoint dot.
  const titleOf = (id) => js(`(() => { const r = document.querySelector(${S(`${node(id)} .vs-title`)}).getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 30), y: r.top + r.height / 2 }; })()`);
  // The middle of a wire's path, found on the SVG path itself.
  const wireMid = (from, to) => js(`(() => { const g = ${V}.graph(); const i = g.links.findIndex((l) => l.from.node === ${S(from)} && l.to.node === ${S(to)});
    const p = document.querySelector(${S(`${HOST} .vs-wire-hit`)} + '[data-link="' + i + '"]'); if (!p) return null;
    const pt = p.getPointAtLength(p.getTotalLength() / 2); const m = p.getScreenCTM(); return { x: m.a * pt.x + m.c * pt.y + m.e, y: m.b * pt.x + m.d * pt.y + m.f }; })()`);
  const menuRow = (label) => js(`(() => {
    const row = [...document.querySelectorAll('.context-menu[data-level="0"] .menu-item')].find((r) => r.firstChild.textContent === ${S(label)});
    if (!row) return null; const r = row.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);
  const menuLabels = () => js(`[...document.querySelectorAll('.context-menu[data-level="0"] .menu-item')].map((r) => r.firstChild.textContent)`);
  return { mouse, move, click, clickOn, center, titleOf, wireMid, menuRow, menuLabels };
}

async function openScript(ctx, name) {
  await ctx.js(`ide.openFile(ide.util.joinPath(ide.root, ${S(name)}))`);
  await ctx.until(`ide.activeTab()?.path.toLowerCase().endsWith(${S(`\\${name}`.toLowerCase())}) && !!${V}?.graph() && !!document.querySelector(${S(`${HOST} .vs-node`)})`, `${name} on the canvas`);
  await ctx.js(`(${V}.fit(), true)`);
  await ctx.js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
}
// Selects a node by a click on its title, which also gives the canvas the keyboard.
async function selectNode(ctx, ui, id) {
  await ui.click(await ui.titleOf(id));
  await ctx.until(`${S(id)} === ${V}.selection().join() && document.activeElement?.classList.contains('vs-canvas')`, `${id} selected, canvas focused`);
}
const bps = (ctx) => ctx.js(`document.querySelector(${S(HOST)}).dataset.breakpoints`);
const pausedAt = (ctx) => ctx.js(`document.querySelector(${S(HOST)}).dataset.paused`);
const stopped = (ctx) => ctx.js('ide.debugger.stopped()');
const debugOut = (ctx) => ctx.js(`document.querySelector('#dbgOut')?.textContent || ''`);
// A first debug session on a cold runner starts debugpy slowly; a timeout says what the debugger and the window showed.
const waitPaused = (ctx, id, label, ms = 30000) => ctx.until(`ide.debugger.stopped() && document.querySelector(${S(HOST)})?.dataset.paused === ${S(id)} && !!document.querySelector(${S(`${node(id)}.vs-paused`)})`, label, ms)
  .catch(async (e) => {
    const seen = await ctx.js(`JSON.stringify({ active: ide.debugger.isActive(), stopped: ide.debugger.stopped(), paused: document.querySelector(${S(HOST)})?.dataset.paused || null, out: (document.querySelector('#dbgOut')?.textContent || '').slice(-800), dialogs: [...document.querySelectorAll('.dialog')].map((d) => d.textContent.slice(0, 300)) })`).catch(() => 'n/a');
    throw new Error(`${e.message}: ${seen}`);
  });
const waitEnded = (ctx, label) => ctx.until(`!ide.debugger.isActive() && (document.querySelector('#dbgOut')?.textContent || '').includes('Process finished with exit code')`, label, 30000);
// Hovers a point and resolves the value bubble's text.
async function hoverValue(ctx, ui, p, label) {
  await ui.move({ x: p.x + 40, y: p.y + 40 });
  await ctx.until(`!document.querySelector('.vs-value-tip:not(.hidden)')`, 'no value bubble');
  await ui.move(p);
  await ctx.until(`!!document.querySelector('.vs-value-tip:not(.hidden)')?.textContent`, `a value bubble for ${label}`);
  return ctx.js(`document.querySelector('.vs-value-tip:not(.hidden)').textContent`);
}

// The shown value bubble, and the header and box of a node, as client rectangles.
const tipOver = (ctx, id) => ctx.js(`(() => { const b = (e) => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) }; };
  return { tip: b(document.querySelector('.vs-value-tip:not(.hidden)')), head: b(document.querySelector(${S(`${node(id)} .vs-head`)})), node: b(document.querySelector(${S(node(id))})) }; })()`);
const overlaps = (a, c) => a.l < c.r && a.r > c.l && a.t < c.b && a.b > c.t;

const t = await sized(await launch({ fixture: 'visual-script-debug', port: 9082, name: 'visual-script-debug' }));
const { js, until, press, type, check, shot } = t;
const ui = inputs(t);
try {
  // ---- breakpoints on nodes ----
  await openScript(t, 'loop.pyflow');
  const loopPath = await js('ide.activeTab().path');
  await selectNode(t, ui, 'n4');
  await press('F9');
  check(await bps(t) === 'n4' && await js(`!!document.querySelector(${S(`${node('n4')} .vs-bp.on`)})`), 'F9 on a selected step sets a breakpoint, drawn as a dot in its header');
  const stored = await js(`ide.settings.get('visualScript.breakpoints')`);
  check(S(Object.values(stored)) === S([['n4']]) && Object.keys(stored)[0].toLowerCase() === loopPath.toLowerCase(), `stored per .pyflow in visualScript.breakpoints (${S(stored)})`);
  check(!readFileSync(loopPath, 'utf8').includes('breakpoint') && await js(`!ide.isDirty(ide.activeTab())`), 'the .pyflow file is unchanged and not dirty');
  await press('F9');
  check(await bps(t) === '' && await js(`!document.querySelector(${S(`${node('n4')} .vs-bp.on`)})`), 'F9 again removes it');
  await press('Ctrl+F8');
  check(await bps(t) === 'n4', 'Ctrl+F8 toggles it too');
  await selectNode(t, ui, 'n8');
  await press('F9');
  check(await bps(t) === 'n4', 'a pure node (Math) takes no breakpoint: it has no line of its own');
  check(await js(`!document.querySelector(${S(`${node('n8')} .vs-bp`)}) && !!document.querySelector(${S(`${node('n5')} .vs-bp`)})`), 'only steps have a breakpoint dot');
  await ui.move(await ui.titleOf('n5'));
  await ui.clickOn(`${node('n5')} .vs-bp`);
  check(await bps(t) === 'n4,n5', 'a click on the header dot sets a breakpoint');
  await ui.clickOn(`${node('n5')} .vs-bp`);
  check(await bps(t) === 'n4', 'a second click removes it');
  await ui.click(await ui.titleOf('n5'), { button: 'right' });
  await until(`!!document.querySelector('.context-menu[data-level="0"]')`, 'node menu');
  check((await ui.menuLabels()).includes('Add Breakpoint') && (await ui.menuLabels()).includes('Edit Condition…'), 'the node menu has Add Breakpoint and Edit Condition…');
  await ui.click(await ui.menuRow('Add Breakpoint'));
  check(await bps(t) === 'n4,n5', 'the node menu adds a breakpoint');
  await ui.click(await ui.titleOf('n5'), { button: 'right' });
  await until(`!!document.querySelector('.context-menu[data-level="0"]')`, 'node menu again');
  check((await ui.menuLabels()).includes('Remove Breakpoint'), 'the menu then offers Remove Breakpoint');
  await ui.click(await ui.menuRow('Remove Breakpoint'));
  check(await bps(t) === 'n4', 'and removes it');

  // ---- Shift+F9: paused on a node in a loop ----
  await selectNode(t, ui, 'n2');
  await press('Shift+F9');
  await waitPaused(t, 'n4', 'paused on the breakpoint node', 90000);
  check(true, 'Shift+F9 on the canvas debugs the script and pauses on the breakpoint node, outlined as paused');
  check(await js(`ide.activeTab().path`) === loopPath && await js(`!ide.groups().flatMap((g) => g.tabs).some((t) => /\\.py$/i.test(t.path))`), 'the .pyflow stays in front; the generated file is not opened');
  await until(`document.querySelector('#dbgVars').textContent.includes('For Range (n3) = {int} 0')`, 'loop index in Variables');
  const indexName = await js(`(() => { const n = [...document.querySelectorAll('#dbgVars .dbg-name')].find((x) => x.textContent === 'For Range (n3)');
    return { title: n?.title, vars: document.querySelector('#dbgVars').textContent }; })()`);
  check(indexName.title === 'index_n3 = 0' && !indexName.vars.includes('index_n3'), `Variables names the loop index after its node (For Range (n3) = 0), the generated name index_n3 in its tooltip (${S(indexName)})`);
  await js(`[...document.querySelectorAll('#dbgVars .dbg-group .dbg-name')].find((n) => n.textContent === 'Globals').parentElement.id = 'vsdGlobals'`);
  await ui.clickOn('#vsdGlobals');
  await until(`[...document.querySelectorAll('#dbgVars .dbg-kids:not(.hidden) .dbg-name')].some((n) => n.textContent === 'total')
    && document.querySelector('#dbgVars .dbg-kids:not(.hidden)').textContent.includes('total = {int} 0')`, 'the Set Variable variable under Globals');
  check(true, 'a Set Variable variable keeps its own name (total = 0 under Globals)');
  await ui.clickOn('#dbgWatchAdd');
  await js(`document.querySelector('#dbgWatchInput').focus()`);
  await type('index_n3');
  await press('Enter');
  await until(`document.querySelector('#dbgWatches').textContent.includes('index_n3 = {int} 0')`, 'a watch on index_n3');
  check(true, 'a watch on the generated name still evaluates (index_n3 = 0)');
  await ui.clickOn('#dbgWatches .dbg-watch-del');
  await until(`!document.querySelector('#dbgWatches .dbg-watch')`, 'the watch removed');
  const frames = await js(`document.querySelector('#dbgFrames').textContent`);
  check(frames.includes('main, loop.pyflow: Set Variable (n4)') && !frames.includes('loop.py:'), `Frames name the .pyflow and the node (${frames})`);
  check(await js(`(() => { const c = document.querySelector(${S(`${HOST} .vs-canvas`)}).getBoundingClientRect(); const r = document.querySelector(${S(node('n4'))}).getBoundingClientRect();
    return r.left >= c.left && r.right <= c.right && r.top >= c.top && r.bottom <= c.bottom; })()`), 'the paused node is in view');
  await shot('paused.png');

  check(await hoverValue(t, ui, await ui.center(pin('n3', 'out', 'index')), 'the index pin') === '0', 'hovering the loop index pin shows 0');
  check(await hoverValue(t, ui, await ui.wireMid('n8', 'n4'), 'the Math wire') === '0', 'hovering a wire shows its value (total + index = 0)');
  const wireTip = await tipOver(t, 'n4');
  check(!overlaps(wireTip.tip, wireTip.head), `the wire's value bubble leaves the paused node's title visible (${S(wireTip)})`);
  check(await hoverValue(t, ui, await ui.center(pin('n9', 'out', 'text')), 'Join Text') === "'i=0'", 'a pure Text node is evaluated (\'i=0\')');
  check(await hoverValue(t, ui, await ui.center(pin('n4', 'in', 'value')), 'an input pin') === '0', 'hovering a wired input shows the value it gets');
  const pinTip = await tipOver(t, 'n4');
  check(!overlaps(pinTip.tip, pinTip.head) && !overlaps(pinTip.tip, pinTip.node), `the value bubble of the paused node's own pin sits beside the node, not over its title (${S(pinTip)})`);
  const notEvaluated = await hoverValue(t, ui, await ui.center(pin('n10', 'out', 'result')), 'Python Expression');
  check(notEvaluated === '(not evaluated: it would run the code again)', `Python Expression is not evaluated again (${notEvaluated})`);
  await ui.move({ x: 5, y: 5 });

  await press('F8');
  await waitPaused(t, 'n5', 'Step Over to the Print node');
  check(await js(`!document.querySelector(${S(`${node('n4')}.vs-paused`)})`), 'Step Over moves the outline to the next node (n4 -> n5)');
  await press('F9');
  await waitPaused(t, 'n4', 'Resume to the next hit');
  check(await hoverValue(t, ui, await ui.center(pin('n3', 'out', 'index')), 'the index pin') === '1', 'Resume runs to the next hit: the index is now 1');
  await ui.move({ x: 5, y: 5 });

  // ---- a condition limits hits ----
  await ui.click(await ui.titleOf('n4'), { button: 'right' });
  await until(`!!document.querySelector('.context-menu[data-level="0"]')`, 'node menu while paused');
  await ui.click(await ui.menuRow('Edit Condition…'));
  await until(`!document.querySelector('#popup').classList.contains('hidden')`, 'the condition prompt');
  await type('total >= 3');
  await press('Enter');
  await until(`PyideVisualScript.debug.breakpoints(ide.activeTab().path)[0]?.condition === 'total >= 3'`, 'condition stored');
  check(await js(`!!document.querySelector(${S(`${node('n4')} .vs-bp.on.cond`)})`), 'a conditional breakpoint is drawn as such');
  check(S(await js(`ide.settings.get('visualScript.breakpointConditions')`)).includes('total >= 3'), 'the condition is stored with the breakpoints');
  await js(`document.querySelector(${S(`${HOST} .vs-canvas`)}).focus()`);
  await press('F9');
  await waitPaused(t, 'n4', 'the conditional hit');
  await until(`document.querySelector('#dbgVars').textContent.includes('For Range (n3) = {int} 3')`, 'index 3 in Variables', 10000);
  check(true, 'with the condition total >= 3 the next pause is at index 3, skipping 2');

  // ---- removing a breakpoint during the session ----
  await selectNode(t, ui, 'n4');
  await press('Ctrl+F8');
  check(await bps(t) === '' && !!(await stopped(t)), 'Ctrl+F8 while paused removes the breakpoint (F9 is Resume while paused)');
  await press('F9');
  await waitEnded(t, 'the program runs to its end');
  const out1 = await debugOut(t);
  check(/i=4\s+20\s/.test(out1) && await pausedAt(t) === '' && await js(`!document.querySelector(${S(`${HOST} .vs-paused`)})`), 'without the breakpoint it runs to the end (prints 20) and the outline is cleared');

  // ---- Step Into a project function and back; Frames; Rerun compiles again ----
  await openScript(t, 'calc.pyflow');
  await selectNode(t, ui, 'n2');
  await press('F9');
  await press('Shift+F9');
  await waitPaused(t, 'n2', 'paused on Call Python');
  await press('F7');
  await until(`ide.activeTab()?.path.toLowerCase().endsWith('\\\\helpers.py') && ide.debugger.stopped()?.frames[0]?.line === 2`, 'Step Into opens helpers.py', 20000);
  check(true, 'Step Into a project function opens its .py file at the line');
  check(await js(`[...document.querySelectorAll('.vs-host')].every((h) => !h.dataset.paused) && !document.querySelector('.vs-paused')`), 'no node is outlined while the program is in the .py file');
  const frames2 = await js(`document.querySelector('#dbgFrames').textContent`);
  check(frames2.includes('double, helpers.py:2') && frames2.includes('main, calc.pyflow: Call Python (n2)'), `Frames show the .py frame and the .pyflow caller (${frames2})`);
  await js(`[...document.querySelectorAll('#dbgFrames .dbg-frame')].find((r) => r.textContent.includes('calc.pyflow')).id = 'vsdFrame'`);
  await ui.clickOn('#vsdFrame');
  await until(`ide.activeTab()?.path.toLowerCase().endsWith('\\\\calc.pyflow') && !!document.querySelector(${S(`${node('n2')}.vs-paused.vs-paused-frame`)})`, 'the caller frame shows its node');
  check(true, 'selecting the .pyflow frame brings the script forward with the calling node outlined as a caller');
  await press('Shift+F8');
  await until(`ide.debugger.stopped()?.index === 0 && ide.activeTab()?.path.toLowerCase().endsWith('\\\\calc.pyflow') && !!document.querySelector(${S(`${node('n2')}.vs-paused:not(.vs-paused-frame)`)})`, 'Step Out back to the node', 20000);
  check(true, 'Step Out returns to the script with the node outlined again');
  await press('F8');
  await waitPaused(t, 'n3', 'Step Over to Print');
  check(true, 'Step Over then goes to the next node');
  await until(`document.querySelector('#dbgVars').textContent.includes('Call Python (n2) = {int} 8')`, 'the call result in Variables');
  check(true, "Variables names a step's result after its node (Call Python (n2) = 8)");
  await press('F9');
  await waitEnded(t, 'calc ends');
  check(/^8$/m.test(await debugOut(t)), 'calc prints 8');
  await ui.clickOn(`${node('n2')} input.vs-field`);
  await press('Ctrl+A');
  await type('5');
  await press('Enter');
  await until(`${V}.graph().nodes.find((n) => n.id === 'n2').inputs?.arg0 === 5`, 'the argument changed to 5');
  await ui.clickOn('#dbgRerun');
  await waitPaused(t, 'n2', 'Rerun pauses on the breakpoint again');
  await press('F9');
  await waitEnded(t, 'the rerun ends');
  check(/^10$/m.test(await debugOut(t)), 'Rerun in the Debug window compiles the edited graph again (prints 10)');

  // ---- an uncaught exception marks its node ----
  await openScript(t, 'boom.pyflow');
  await ui.clickOn('#debugBtn');
  await until(`ide.debugger.stopped()?.reason === 'exception'`, 'stopped on the exception', 30000);
  await waitPaused(t, 'n4', 'paused on the failing node');
  await until(`!!document.querySelector(${S(`${node('n4')}.vs-runtime-err`)})`, 'the node is marked');
  const errText = await js(`document.querySelector(${S(HOST)}).textContent`);
  check(errText.includes('ZeroDivisionError: division by zero') && await js(`document.querySelectorAll(${S(`${HOST} .vs-runtime-err`)}).length`) === 1, 'the toolbar Debug button debugs the script; the exception marks its node with "ZeroDivisionError: division by zero"');
  await shot('exception.png');
  await press('F9');
  await waitEnded(t, 'boom ends');
  check(/before/.test(await debugOut(t)) && !/after/.test(await debugOut(t)), 'steps before the error ran, steps after did not');

  // ---- src layout: a graph calling src/shop/cart.py runs and debugs ----
  await openScript(t, 'shop.pyflow');
  await selectNode(t, ui, 'n3');
  await press('Shift+F10');
  await until(`(document.querySelector('#runOut')?.textContent || '').includes('Process finished with exit code')`, 'the src-layout script runs', 30000);
  const shopRun = await js(`document.querySelector('#runOut').textContent`);
  check(/\n12\s*\n/.test(shopRun) && shopRun.includes('exit code 0'), `Run finds a src-layout module (from shop.cart import total prints 12)`);
  await selectNode(t, ui, 'n2');
  await press('F9');
  await press('Shift+F9');
  await waitPaused(t, 'n2', 'paused on the src-layout call');
  await press('F7');
  await until(`(ide.activeTab()?.path || '').toLowerCase().endsWith(['', 'src', 'shop', 'cart.py'].join(String.fromCharCode(92))) && ide.debugger.stopped()?.frames[0]?.line === 2`, 'Step Into opens src/shop/cart.py', 20000);
  check(true, 'debugging steps into the src-layout module (src/shop/cart.py, line 2)');
  await press('F9');
  await waitEnded(t, 'shop ends');
  check(/^12$/m.test(await debugOut(t)), 'the debugged src-layout script prints 12');

  // ---- the changed-signature row is styled by style.css in both themes ----
  await openScript(t, 'shop.pyflow');
  const staleStyle = `(() => { const host = document.querySelector(${S(HOST)}); const n = document.querySelector(${S(node('n2'))});
    const box = document.createElement('div'); box.className = 'vs-props vs-stale';
    box.innerHTML = '<span class="vs-prop-name vs-stale-text">x</span><button class="vs-btn vs-update">Update</button>'; n.appendChild(box);
    const text = getComputedStyle(box.firstChild); const btn = getComputedStyle(box.lastChild);
    const r = { color: text.color, muted: getComputedStyle(host).getPropertyValue('--vs-muted'), wrap: text.whiteSpace, align: btn.alignSelf,
      contrast: (${contrastOf})(text.color, getComputedStyle(n).backgroundColor) };
    box.remove(); return r; })()`;
  const staleDark = await js(staleStyle);
  await js(`(ide.settings.set('appearance.theme', 'light'), true)`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'light theme');
  const staleLight = await js(staleStyle);
  await js(`(ide.settings.set('appearance.theme', 'dark'), true)`);
  await until(`document.documentElement.dataset.theme === 'dark'`, 'dark theme');
  const staleOk = (x) => x.wrap === 'normal' && x.align === 'flex-start' && x.contrast >= 4.5;
  check(staleOk(staleDark) && staleOk(staleLight) && staleDark.color !== staleLight.color, `the "parameters changed" row is styled in both themes (dark ${staleDark.color} ${staleDark.contrast.toFixed(2)}, light ${staleLight.color} ${staleLight.contrast.toFixed(2)})`);

  // ---- a breakpoint with a condition for the restart ----
  await openScript(t, 'loop.pyflow');
  await ui.click(await ui.titleOf('n5'), { button: 'right' });
  await until(`!!document.querySelector('.context-menu[data-level="0"]')`, 'node menu for n5');
  await ui.click(await ui.menuRow('Edit Condition…'));
  await until(`!document.querySelector('#popup').classList.contains('hidden')`, 'the condition prompt for n5');
  await type('index_n3 == 2');
  await press('Enter');
  await until(`document.querySelector(${S(HOST)}).dataset.breakpoints === 'n5'`, 'n5 has a conditional breakpoint');
  check(true, 'Edit Condition… on a node without a breakpoint adds one with the condition');
  await js('ide.settings.flush()');
  const restartData = t.userData;
  t.close();

  // ---- breakpoints survive a restart ----
  const r = await sized(await launch({ fixture: 'visual-script-debug', port: 9083, name: 'visual-script-debug-restart', userData: restartData, projectDir: t.project }));
  const rui = inputs(r);
  try {
    await openScript(r, 'loop.pyflow');
    r.check(await bps(r) === 'n5' && await r.js(`!!document.querySelector(${S(`${node('n5')} .vs-bp.on.cond`)})`), 'after a restart the script shows its conditional breakpoint');
    await selectNode(r, rui, 'n2');
    await r.press('Shift+F9');
    await waitPaused(r, 'n5', 'paused after the restart');
    await r.until(`document.querySelector('#dbgVars').textContent.includes('For Range (n3) = {int} 2')`, 'index 2', 10000);
    r.check(true, 'and debugging pauses there when its condition holds (index 2)');
    await r.press('F9');
    await waitEnded(r, 'ends after the restart');
    r.check(r.consoleErrors.length === 0, 'no renderer exceptions after the restart');
  } catch (err) {
    r.check(false, err.message);
  }
  for (const x of r.results) t.results.push(x);
  r.close();

  // ---- Korean ----
  const ko = await sized(await launch({ fixture: 'visual-script-debug', port: 9084, name: 'visual-script-debug-ko', lang: 'ko-KR' }));
  const kui = inputs(ko);
  try {
    await openScript(ko, 'loop.pyflow');
    await kui.click(await kui.titleOf('n4'), { button: 'right' });
    await ko.until(`!!document.querySelector('.context-menu[data-level="0"]')`, 'Korean node menu');
    const labels = await kui.menuLabels();
    ko.check(labels.includes('중단점 추가') && labels.includes('조건 편집…'), `the node menu is Korean (${S(labels)})`);
    await kui.click(await kui.menuRow('중단점 추가'));
    await ko.until(`document.querySelector(${S(HOST)}).dataset.breakpoints === 'n4'`, 'Korean: breakpoint set');
    await selectNode(ko, kui, 'n2');
    await ko.press('Shift+F9');
    await waitPaused(ko, 'n4', 'Korean: paused');
    const frames3 = await ko.js(`document.querySelector('#dbgFrames').textContent`);
    ko.check(frames3.includes('loop.pyflow: 변수 설정 (n4)'), `Korean: Frames use the node's Korean title (${frames3})`);
    await ko.until(`document.querySelector('#dbgVars').textContent.includes('범위 반복 (for range) (n3) = {int} 0')`, 'Korean: the loop index in Variables');
    const koIndex = await ko.js(`[...document.querySelectorAll('#dbgVars .dbg-name')].find((x) => x.textContent === '범위 반복 (for range) (n3)')?.title`);
    ko.check(koIndex === 'index_n3 = 0', `Korean: Variables names the loop index with the node's Korean title, index_n3 in the tooltip (${koIndex})`);
    const ne = await hoverValue(ko, kui, await kui.center(pin('n10', 'out', 'result')), 'Korean Python Expression');
    ko.check(ne === '(평가하지 않음: 코드를 다시 실행하게 됩니다)', `Korean: the not-evaluated note (${ne})`);
    ko.check(await hoverValue(ko, kui, await kui.center(pin('n3', 'out', 'index')), 'Korean index') === '0', 'Korean: values on hover');
    const leaks = await englishLeaks(ko, HOST);
    ko.check(!leaks.length, `Korean: no English in the paused tab (${S(leaks)})`);
    await kui.move({ x: 5, y: 5 });
    await ko.press('F9');
    await ko.until(`ide.debugger.stopped()`, 'Korean: next hit', 20000);
    await ko.js(`ide.runAction('StopDebug')`);
    await ko.until(`!ide.debugger.isActive()`, 'Korean: stopped');
    ko.check(!(await missingTranslations(ko)).some((s) => /breakpoint|condition|evaluated|no value|debug/i.test(s)), 'Korean: every debugging string is translated');
    ko.check(ko.consoleErrors.length === 0, 'Korean: no renderer exceptions');
  } catch (err) {
    ko.check(false, err.message);
  }
  for (const x of ko.results) t.results.push(x);
  ko.close();
} catch (err) {
  check(false, err.message);
  await shot('failure.png').catch(() => {});
}
t.finish();
