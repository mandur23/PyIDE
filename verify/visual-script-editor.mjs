// Visual Scripting editor (renderer/features/visual-script/editor.js). Ports 9090-9094.
// Drives the *.pyflow tab with real CDP mouse, wheel and key events: rendering (wires on their pins, no overlapping
// pins), the palette (Tab, double-click, typing, Korean keywords, a wire dropped on empty space), wiring (connect,
// refuse an incompatible pin, replace a data link, Alt+click), literals and props, select / box-select / move /
// delete / copy / paste / duplicate, undo and redo through the document, save and reload from disk, Open as Text,
// closing a dirty tab (also with Ctrl+F4 while a field is being typed in), Ctrl+S keeping the keyboard in a field, numbers
// fields keep exact (01012345678, 20 digits), the palette ranking a whole keyword first, pan / zoom / Fit, live
// problems, empty and broken files, the frame time of a 200-node graph,
// and the Light theme.
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { launch, openFile } from './lib.mjs';

const S = JSON.stringify;
const require = createRequire(import.meta.url);
const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const VSDIR = path.join(APP, 'renderer', 'features', 'visual-script');
require(path.join(VSDIR, 'model.js'));
require(path.join(VSDIR, 'nodes.js'));
const VS = require(path.join(VSDIR, 'codegen.js'));

const ctx = await launch({ fixture: 'visual-script', port: 9090, name: 'visual-script-editor' });
const { js, until, press, type, shot, check, cdp, sleep, project } = ctx;
// `--viewport=1008x681` gives the window the inner size it has on CI's 1024x768 screen.
const viewport = process.argv.find((a) => a.startsWith('--viewport='))?.slice(11).split('x').map(Number);
if (viewport) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: viewport[0], height: viewport[1], deviceScaleFactor: 1, mobile: false });
  await until(`Math.abs(innerWidth - ${viewport[0]}) <= 1 && Math.abs(innerHeight - ${viewport[1]}) <= 1`, 'the emulated viewport');
}
const demoPath = path.join(project, 'demo.pyflow');

const V = 'ide.activeTab().visualScript';
const graph = () => js(`JSON.parse(JSON.stringify(${V}.graph()))`);
const nodeOf = async (id) => (await graph()).nodes.find((n) => n.id === id);
const linksInto = async (id, pin) => (await graph()).links.filter((l) => l.to.node === id && l.to.pin === pin);
const docText = () => js(`ide.activeTab().doc.model.getValue()`);
const dirty = () => js(`ide.isDirty(ide.activeTab())`);
const selection = () => js(`${V}.selection().join(',')`);
const view = () => js(`${V}.view()`);
const center = (selector) => js(`(() => { const n = document.querySelector(${S(selector)}); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const pin = (node, side, id) => center(`.vs-host:not(.hidden) .vs-pin[data-node="${node}"][data-side="${side}"][data-pin="${id}"]`);
// A node's header; for a Comment (drawn behind other nodes) the first point from its top-left corner that no other
// node covers.
const head = (node) => js(`(() => { const n = document.querySelector('.vs-host:not(.hidden) .vs-node[data-id="${node}"]'); if (!n) return null;
  const h = n.querySelector('.vs-head'); const r = (h || n).getBoundingClientRect();
  if (h) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  for (let y = r.top + 8; y < r.bottom - 2; y += 4) for (let x = r.left + 10; x < r.right - 2; x += 6) if (document.elementFromPoint(x, y)?.closest('.vs-node') === n) return { x, y };
  return null; })()`);
// What the pointer would hit at a point, for failure messages.
const hitAt = (p) => js(`(() => { const e = document.elementFromPoint(${p?.x}, ${p?.y}); if (!e) return 'nothing'; const n = e.closest('.vs-node');
  return (e.className?.baseVal ?? e.className) + (e.dataset.pin ? ' ' + e.dataset.node + '.' + e.dataset.pin : n ? ' in ' + n.dataset.id : ''); })()`);
// A canvas point with nothing under it, searched on a grid from the bottom-left of the canvas. With `room` ({w, h} in
// graph units), a node added at the point must also fit inside the canvas without covering another node, so later steps
// can reach every pin and field; the view is zoomed out until there is such a spot, as a user would make room.
const emptySpot = async (room) => {
  for (;;) {
    const spot = await js(`(() => { const c = document.querySelector('.vs-host:not(.hidden) .vs-canvas').getBoundingClientRect();
      const s = ${V}.view().s; const room = ${S(room || null)};
      const taken = [...document.querySelectorAll('.vs-host:not(.hidden) .vs-node, .vs-host:not(.hidden) .vs-palette')].map((e) => e.getBoundingClientRect());
      const fits = (x, y) => { if (!room) return true;
        const a = { left: x - 16 * s, top: y - 24 * s, right: x + room.w * s, bottom: y + room.h * s };
        return a.left >= c.left + 2 && a.top >= c.top + 2 && a.right <= c.right - 2 && a.bottom <= c.bottom - 2
          && !taken.some((q) => q.left < a.right && q.right > a.left && q.top < a.bottom && q.bottom > a.top); };
      for (let y = c.bottom - 30; y > c.top + 30; y -= 20) for (let x = c.left + 30; x < c.right - 30; x += 20) {
        const t = document.elementFromPoint(x, y);
        if (t && (t.classList.contains('vs-canvas') || t.classList.contains('vs-nodes')) && !document.elementsFromPoint(x, y).some((e) => e.closest?.('.vs-node, .vs-palette')) && fits(x, y)) return { x, y };
      }
      return null; })()`);
    if (spot || !room) return spot;
    if (!(await js(`(() => { const v = ${V}.view(); if (v.s <= 0.26) return false; const c = document.querySelector('.vs-host:not(.hidden) .vs-canvas');
      const s = Math.max(0.25, v.s / 1.2); const cx = c.clientWidth / 2; const cy = c.clientHeight / 2;
      ${V}.setView({ s, tx: cx - ((cx - v.tx) / v.s) * s, ty: cy - ((cy - v.ty) / v.s) * s }); return true; })()`))) return null;
    await sleep(60);
  }
};
const NODE_ROOM = { w: 260, h: 120 };

const BUTTONS = { left: 1, right: 2, middle: 4 };
const mouse = (type, p, { button = 'left', clickCount = 1, modifiers = 0, pressed = button } = {}) => cdp('Input.dispatchMouseEvent', {
  type, x: p.x, y: p.y, button: type === 'mouseMoved' && !pressed ? 'none' : button, buttons: type === 'mouseReleased' || !pressed ? 0 : BUTTONS[button], clickCount, modifiers,
});
const move = (p) => mouse('mouseMoved', p, { pressed: null });
async function click(p, opts = {}) {
  await move(p);
  await mouse('mousePressed', p, opts);
  await mouse('mouseReleased', p, opts);
  await sleep(80);
}
async function dblclick(p) {
  await move(p);
  for (const clickCount of [1, 2]) {
    await mouse('mousePressed', p, { clickCount });
    await mouse('mouseReleased', p, { clickCount });
  }
  await sleep(120);
}
// A drag with intermediate moves; `during` runs before the release (the pointer still over `to`).
async function drag(from, to, { button = 'left', modifiers = 0, steps = 8, during } = {}) {
  await move(from);
  await mouse('mousePressed', from, { button, modifiers });
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }, { button, modifiers });
    await sleep(16);
  }
  await sleep(50);
  const seen = during ? await during() : undefined;
  await mouse('mouseReleased', to, { button, modifiers });
  await sleep(120);
  return seen;
}
const wheel = async (p, deltaY, modifiers = 0) => { await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY, modifiers }); await sleep(40); };
const key = async (type, k, code, keyCode, modifiers = 0) => cdp('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: keyCode, modifiers });
const focusCanvas = () => js(`document.querySelector('.vs-host:not(.hidden) .vs-canvas').focus()`);
const settle = () => sleep(150);

try {
  await openFile(ctx, 'demo.pyflow');
  await until(`document.querySelector('.vs-host:not(.hidden)')?.dataset.nodes === '9'`, 'demo.pyflow drawn');
  await until(`document.querySelector('.vs-host:not(.hidden) .vs-problems')?.textContent === 'No problems'`, 'problems computed');
  await sleep(300);
  check((await js(`document.querySelectorAll('.vs-host:not(.hidden) .vs-wire').length`)) === 9, 'demo.pyflow opens as a canvas with 9 nodes and 9 wires');
  check(!(await dirty()), 'opening (and fitting the view) does not make the file dirty');
  const exec = await js(`[...document.querySelectorAll('.vs-host:not(.hidden) .vs-wire-exec')].length`);
  check(exec === 5, `exec wires are drawn as exec wires (${exec})`);
  check(await js(`[...document.querySelectorAll('.vs-host:not(.hidden) .vs-pin, .vs-host .vs-toolbar .vs-btn')].every((p) => p.title)`), 'every pin and toolbar button has a title');
  check(await js(`document.querySelector('.vs-host:not(.hidden) .vs-node[data-id="n7"] .vs-title').textContent.includes('*')`), 'a node title shows its operator (Math *)');
  check(await js(`document.querySelector('.vs-host:not(.hidden) .vs-node[data-id="n9"]').classList.contains('vs-comment')`), 'a Comment node is drawn as a note');

  const wiresOnPins = () => js(`(() => {
    const host = document.querySelector('.vs-host:not(.hidden)'); const g = ${V}.graph(); const bad = [];
    const hits = [...host.querySelectorAll('.vs-wire-hit')];
    for (const h of hits) {
      const l = g.links[Number(h.dataset.link)];
      const len = h.getTotalLength(); const m = h.getScreenCTM();
      const at = (d) => { const p = h.getPointAtLength(d).matrixTransform(m); return { x: p.x, y: p.y }; };
      const c = (n, side, pin) => { const r = host.querySelector('.vs-pin[data-node="' + n + '"][data-side="' + side + '"][data-pin="' + pin + '"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
      const a = at(0); const b = at(len); const pa = c(l.from.node, 'out', l.from.pin); const pb = c(l.to.node, 'in', l.to.pin);
      const d = Math.max(Math.hypot(a.x - pa.x, a.y - pa.y), Math.hypot(b.x - pb.x, b.y - pb.y));
      if (d > 1.5) bad.push(l.from.node + '.' + l.from.pin + '>' + l.to.node + '.' + l.to.pin + ' off by ' + d.toFixed(1));
    }
    return { n: hits.length, bad };
  })()`);
  let w = await wiresOnPins();
  check(w.n === 9 && !w.bad.length, `every wire ends on its pins at the fitted zoom (${w.bad.join('; ') || 'ok'})`);
  const layoutProblems = () => js(`(() => {
    const out = []; const host = document.querySelector('.vs-host:not(.hidden)');
    for (const n of host.querySelectorAll('.vs-node')) {
      const boxes = [...n.querySelectorAll('.vs-pin, .vs-field, .vs-label, .vs-title')].map((e) => ({ e, r: e.getBoundingClientRect() })).filter((b) => b.r.width);
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r; const b = boxes[j].r;
        if (boxes[i].e.contains(boxes[j].e) || boxes[j].e.contains(boxes[i].e)) continue;
        const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left); const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ix > 1 && iy > 1) out.push(n.dataset.id + ': ' + boxes[i].e.className + ' overlaps ' + boxes[j].e.className);
      }
      for (const t of n.querySelectorAll('.vs-label, .vs-title')) if (t.scrollWidth > t.clientWidth + 1) out.push(n.dataset.id + ': clipped ' + t.textContent);
      const r = n.getBoundingClientRect();
      for (const p of n.querySelectorAll('.vs-pin')) { const q = p.getBoundingClientRect(); if (q.left < r.left - 1 || q.right > r.right + 1) out.push(n.dataset.id + ': pin outside ' + p.dataset.pin); }
    }
    return out;
  })()`);
  let lp = await layoutProblems();
  check(!lp.length, `no overlapping pins, fields or labels, no clipped text, pins inside their node (${lp.slice(0, 4).join('; ') || 'ok'})`);
  await shot('dark.png');

  await focusCanvas();
  let spot = await emptySpot(NODE_ROOM);
  await move(spot);
  await press('Tab');
  await until(`document.querySelector('.vs-host:not(.hidden)')?.dataset.palette === 'open'`, 'palette on Tab');
  check(await js(`document.activeElement?.classList.contains('vs-pal-input')`), 'Tab opens the palette with the search field focused');
  const palBox = await js(`(() => { const r = (e) => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom].map(Math.round); };
    return { palette: r(document.querySelector('.vs-host:not(.hidden) .vs-palette')), tab: r(document.querySelector('.vs-host:not(.hidden)')) }; })()`);
  check(palBox.palette[0] >= palBox.tab[0] && palBox.palette[1] >= palBox.tab[1] && palBox.palette[2] <= palBox.tab[2] && palBox.palette[3] <= palBox.tab[3], `the palette stays inside the tab (${S(palBox)})`);
  check(await js(`document.querySelectorAll('.vs-host:not(.hidden) .vs-pal-cat').length >= 6 && !document.querySelector('.vs-host:not(.hidden) .vs-pal-item[data-type="core.start"]')`), 'the palette lists node types under categories (no second Start)');
  await type('set var');
  await sleep(100);
  check(await js(`document.querySelector('.vs-host:not(.hidden) .vs-pal-item.vs-active')?.dataset.type`) === 'var.set', 'typing "set var" filters to Set Variable');
  await press('Enter');
  await until(`document.querySelector('.vs-host:not(.hidden)')?.dataset.nodes === '10'`, 'node added from the palette');
  const added = (await graph()).nodes.find((n) => n.type === 'var.set');
  const want = await js(`(() => { const c = document.querySelector('.vs-host:not(.hidden) .vs-canvas').getBoundingClientRect(); const v = ${V}.view(); return { x: (${spot.x} - c.left - v.tx) / v.s, y: (${spot.y} - c.top - v.ty) / v.s }; })()`);
  check(added && Math.abs(added.x - want.x) <= 16 && Math.abs(added.y - want.y) <= 32, `Enter adds the node at the pointer (${added?.x},${added?.y} vs ${Math.round(want.x)},${Math.round(want.y)})`);
  check(await dirty() && (await docText()).includes('"type": "var.set"'), 'the new node is written into the document, which is now dirty');
  check(await selection() === added.id, 'the new node is selected');
  await press('Ctrl+Z');
  await until(`document.querySelector('.vs-host:not(.hidden)')?.dataset.nodes === '9'`, 'undo add');
  check(!(await dirty()), 'Ctrl+Z removes it again and the file is clean');
  await press('Ctrl+Y');
  await until(`document.querySelector('.vs-host:not(.hidden)')?.dataset.nodes === '10'`, 'redo add');
  check(true, 'Ctrl+Y adds it back');

  spot = await emptySpot();
  await dblclick(spot);
  await until(`document.querySelector('.vs-host:not(.hidden)')?.dataset.palette === 'open'`, 'palette on double-click');
  await type('출력');
  await sleep(100);
  const ko = await js(`[...document.querySelectorAll('.vs-host:not(.hidden) .vs-pal-item')].map((e) => e.dataset.type)`);
  check(ko.includes('io.print'), `Korean keywords find nodes ("출력" -> ${ko.join(', ')})`);
  await press('Escape');
  await until(`!document.querySelector('.vs-host:not(.hidden) .vs-palette')`, 'palette closed');
  check(await js(`document.activeElement?.classList.contains('vs-canvas')`), 'Escape closes the palette and gives the keyboard back to the canvas');
  await press('ArrowDown');
  spot = await emptySpot(NODE_ROOM);
  await move(spot);
  await press('Tab');
  await until(`document.querySelector('.vs-host:not(.hidden)')?.dataset.palette === 'open'`, 'palette again');
  await type('number');
  await press('ArrowDown');
  await press('ArrowUp');
  const numType = await js(`document.querySelector('.vs-host:not(.hidden) .vs-pal-item.vs-active')?.dataset.type`);
  await press('Enter');
  await until(`document.querySelector('.vs-host:not(.hidden)')?.dataset.nodes === '11'`, 'number node');
  check(numType === 'value.number', `Up/Down/Enter pick from the filtered list (${numType})`);

  const setId = added.id;
  const numId = (await graph()).nodes.find((n) => n.type === 'value.number').id;
  const ends = async (a, b) => { const [p, q] = [await pin(...a), await pin(...b)]; return { p, q, seen: `under the start: ${await hitAt(p)}, under the end: ${await hitAt(q)}` }; };
  let wire = await ends(['n8', 'out', 'next'], [setId, 'in', 'in']);
  await drag(wire.p, wire.q);
  check((await linksInto(setId, 'in')).some((l) => l.from.node === 'n8' && l.from.pin === 'next'), `dragging from an exec output to an exec input connects them (${wire.seen})`);
  wire = await ends([setId, 'in', 'value'], [numId, 'out', 'value']);
  await drag(wire.p, wire.q);
  check((await linksInto(setId, 'value')).some((l) => l.from.node === numId), `dragging from a data input to a data output connects them too (${wire.seen})`);
  const linkCount = (await graph()).links.length;
  const verdict = await drag(await pin('n2', 'out', 'answer'), await pin('n5', 'in', 'stop'), {
    during: () => js(`({ wire: document.querySelector('.vs-host:not(.hidden) .vs-canvas').dataset.wire, red: getComputedStyle(document.querySelector('.vs-host:not(.hidden) .vs-temp')).stroke, hint: document.querySelector('.vs-host:not(.hidden) .vs-hint').textContent })`),
  });
  check(verdict.wire === 'bad' && /rgb\(2[0-9]{2}, [0-9]{1,2}, [0-9]{2}\)/.test(verdict.red), `an incompatible pin shows the dragged wire red (${verdict.wire}, ${verdict.red})`);
  check(/cannot go into/.test(verdict.hint), `the status line says why (${verdict.hint})`);
  check((await graph()).links.length === linkCount && !(await linksInto('n5', 'stop')).length, 'releasing on an incompatible pin connects nothing');
  await drag(await pin('n5', 'out', 'index'), await pin('n6', 'in', 'value'));
  const into = await linksInto('n6', 'value');
  check(into.length === 1 && into[0].from.node === 'n5' && into[0].from.pin === 'index', 'connecting into a taken data input replaces its link');
  await press('Ctrl+Z');
  await until(`${V}.graph().links.some((l) => l.to.node === 'n6' && l.from.node === 'n7')`, 'undo replace');
  check((await linksInto('n6', 'value')).length === 1, 'one Ctrl+Z restores the replaced link');

  spot = await emptySpot(NODE_ROOM);
  await drag(await pin('n2', 'out', 'answer'), spot);
  await until(`document.querySelector('.vs-host:not(.hidden)')?.dataset.palette === 'open'`, 'palette after a dropped wire');
  const fits = await js(`[...document.querySelectorAll('.vs-host:not(.hidden) .vs-pal-item')].map((e) => e.dataset.type)`);
  check(fits.includes('io.print') && fits.includes('text.join') && !fits.includes('math.not') && !fits.includes('value.number'), `the palette lists only nodes with a pin that fits (${fits.length} types)`);
  await type('join');
  await press('Enter');
  await until(`${V}.graph().nodes.some((n) => n.type === 'text.join')`, 'join node');
  const join = (await graph()).nodes.find((n) => n.type === 'text.join');
  check((await graph()).links.some((l) => l.from.node === 'n2' && l.from.pin === 'answer' && l.to.node === join.id), 'the new node is wired to the dragged pin');

  const hit = await js(`(() => { const g = ${V}.graph(); const i = g.links.findIndex((l) => l.to.node === '${join.id}'); const h = document.querySelector('.vs-host:not(.hidden) .vs-wire-hit[data-link="' + i + '"]'); const len = h.getTotalLength();
    for (let d = len * 0.1; d < len; d += 4) { const p = h.getPointAtLength(d).matrixTransform(h.getScreenCTM()); if (document.elementFromPoint(p.x, p.y) === h) return { x: p.x, y: p.y }; }
    return null; })()`);
  check(!!hit, 'the wire can be hit somewhere along its length');
  await click(hit, { modifiers: 1 });
  check(!(await graph()).links.some((l) => l.to.node === join.id), 'Alt+click on a wire deletes it');
  await click(await pin('n5', 'out', 'index'), { modifiers: 1 });
  check(!(await graph()).links.some((l) => l.from.node === 'n5' && l.from.pin === 'index'), 'Alt+click on a pin deletes its wires');
  await press('Ctrl+Z');
  await press('Ctrl+Z');
  await until(`${V}.graph().links.some((l) => l.from.node === 'n5' && l.from.pin === 'index') && ${V}.graph().links.some((l) => l.to.node === '${join.id}')`, 'undo alt-clicks');
  check(true, 'each Alt+click is one undo step');

  const field = (node, sel) => `.vs-host:not(.hidden) .vs-node[data-id="${node}"] ${sel}`;
  const stopField = await js(`(() => { const f = [...document.querySelectorAll('.vs-host:not(.hidden) .vs-node[data-id="n5"] .vs-row')].find((r) => r.querySelector('.vs-pin[data-pin="stop"]')).querySelector('.vs-field'); const r = f.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await click(stopField);
  await press('Ctrl+A');
  await type('5');
  await press('Enter');
  check((await nodeOf('n5')).inputs.stop === 5 && (await docText()).includes('"stop": 5'), 'typing 5 into a number field and pressing Enter stores the number 5');
  check(await js(`document.activeElement?.classList.contains('vs-canvas')`), 'Enter leaves the field for the canvas');
  await click(stopField);
  await press('Ctrl+A');
  await type('abc');
  check(await js(`document.activeElement.classList.contains('vs-invalid')`), 'a number field marks text that is not a number');
  await press('Escape');
  await settle();
  check((await nodeOf('n5')).inputs.stop === 5 && await js(`document.querySelector('${field('n5', '.vs-row:nth-child(2) .vs-field')}').value === '5'`), 'a bad number is not stored and the field shows the stored value again');
  const doneField = await center(field('n8', '.vs-field'));
  await click(doneField);
  await press('Ctrl+A');
  await type('42');
  await press('Enter');
  check((await nodeOf('n8')).inputs.value === 42, 'an "any" field stores 42 as a number');
  await click(doneField);
  await press('Ctrl+A');
  await type('"42"');
  await press('Enter');
  check((await nodeOf('n8')).inputs.value === '42', 'and "42" in quotes as text');
  const tpl = await center(field('n3', '.vs-prop .vs-field'));
  await click(tpl);
  await press('Ctrl+A');
  await type('Hi {name}, you are {age}');
  await press('Enter');
  await until(`!!document.querySelector('.vs-host:not(.hidden) .vs-pin[data-node="n3"][data-pin="age"]')`, 'template pins');
  check((await nodeOf('n3')).props.template === 'Hi {name}, you are {age}', 'editing a text prop stores it');
  check((await linksInto('n3', 'name')).length === 1, 'a prop that adds pins keeps the existing wires');
  await js(`document.querySelector('${field('n7', '.vs-select')}').focus()`);
  await press('ArrowDown');
  await settle();
  check((await nodeOf('n7')).props.op === '/', `a select prop changes with the keyboard (* -> ${(await nodeOf('n7')).props.op})`);
  check(await js(`document.querySelector('.vs-host:not(.hidden) .vs-node[data-id="n7"] .vs-title').textContent.includes('/')`), 'the title follows the operator');
  await js(`${V}.centerOn('${setId}')`);
  await sleep(100);
  const nameField = await center(`.vs-host:not(.hidden) .vs-node[data-id="${setId}"] .vs-prop .vs-field`);
  const nameSeen = await hitAt(nameField);
  await click(nameField);
  await press('Ctrl+A');
  await type('2bad');
  check(await js(`document.activeElement.classList.contains('vs-invalid') && !!document.activeElement.title`), `an identifier field marks a name that is not valid Python, with a tooltip (under the click: ${nameSeen})`);
  await press('Ctrl+A');
  await type('total');
  await press('Enter');
  check((await nodeOf(setId)).props?.name === 'total', 'a valid name is stored');
  await click(await center('.vs-host:not(.hidden) .vs-fit'));
  await sleep(100);

  await click(await head('n2'));
  check(await selection() === 'n2', 'click selects a node');
  await click(await head('n4'), { modifiers: 8 });
  check(await selection() === 'n2,n4', 'Shift+click adds to the selection');
  await click(await head('n4'), { modifiers: 2 });
  check(await selection() === 'n2', 'Ctrl+click removes a selected node');
  spot = await emptySpot();
  await click(spot);
  check(await selection() === '', 'clicking empty space clears the selection');
  const rect = await js(`(() => { const a = document.querySelector('.vs-host:not(.hidden) .vs-node[data-id="n6"]').getBoundingClientRect(); const b = document.querySelector('.vs-host:not(.hidden) .vs-node[data-id="n8"]').getBoundingClientRect(); return { x0: Math.min(a.left, b.left) - 12, y0: Math.min(a.top, b.top) - 12, x1: Math.max(a.right, b.right) + 12, y1: Math.max(a.bottom, b.bottom) + 12 }; })()`);
  const boxSeen = await drag({ x: rect.x1, y: rect.y0 }, { x: rect.x0 + 30, y: rect.y1 }, { during: () => js(`!document.querySelector('.vs-host:not(.hidden) .vs-box').classList.contains('hidden')`) });
  const boxed = (await selection()).split(',').sort();
  check(boxSeen && boxed.includes('n6') && boxed.includes('n8') && !boxed.includes('n2'), `dragging on empty space draws a selection box and selects what it touches (${boxed.join(',')})`);

  const before = await nodeOf('n9');
  const s0 = (await view()).s;
  const h9 = await head('n9');
  const versions = await js(`ide.activeTab().doc.model.getAlternativeVersionId()`);
  await drag(h9, { x: h9.x + 100, y: h9.y + 50 }, { steps: 12 });
  const after = await nodeOf('n9');
  check(after.x % 16 === 0 && after.y % 16 === 0 && Math.abs(after.x - before.x - 100 / s0) <= 16 && Math.abs(after.y - before.y - 50 / s0) <= 16, `dragging a node moves it, snapped to the 16 px grid (${before.x},${before.y} -> ${after.x},${after.y})`);
  check(await selection() === 'n9', 'dragging an unselected node selects it');
  check(await js(`ide.activeTab().doc.model.getAlternativeVersionId()`) === versions + 1, 'a drag is one edit of the document, not one per mouse move');
  await press('Ctrl+Z');
  await until(`${V}.graph().nodes.find((n) => n.id === 'n9').x === ${before.x}`, 'undo move');
  check(true, 'one Ctrl+Z undoes the whole drag');
  const h9b = await head('n9');
  await drag(h9b, { x: h9b.x + 37, y: h9b.y + 21 }, { modifiers: 1 });
  const alt = await nodeOf('n9');
  check(Math.abs(alt.x - before.x - Math.round(37 / s0)) <= 1 && Math.abs(alt.y - before.y - Math.round(21 / s0)) <= 1, `Alt+drag does not snap (${alt.x - before.x}, ${alt.y - before.y})`);
  w = await wiresOnPins();
  check(!w.bad.length, `wires follow moved nodes (${w.bad.join('; ') || 'ok'})`);

  await click(await head('n8'));
  await press('Delete');
  check(!(await graph()).nodes.some((n) => n.id === 'n8') && !(await graph()).links.some((l) => l.to.node === 'n8' || l.from.node === 'n8'), 'Delete removes the selected node and its wires');
  await press('Ctrl+Z');
  await until(`${V}.graph().nodes.some((n) => n.id === 'n8')`, 'undo delete');
  check((await graph()).links.some((l) => l.to.node === 'n8'), 'Ctrl+Z brings the node back with its wires');

  await click(await head('n6'));
  await click(await head('n7'), { modifiers: 8 });
  await press('Ctrl+C');
  const clip = await js(`navigator.clipboard.readText()`);
  check(/"nodes"/.test(clip) && /"io\.print"/.test(clip) && /"math\.binary"/.test(clip), 'Ctrl+C puts the selected nodes on the clipboard as JSON');
  const nBefore = (await graph()).nodes.length;
  spot = await emptySpot();
  await move(spot);
  await press('Ctrl+V');
  await until(`${V}.graph().nodes.length === ${nBefore + 2}`, 'paste');
  const pasted = (await selection()).split(',');
  const g1 = await graph();
  check(pasted.length === 2 && pasted.every((id) => !['n6', 'n7'].includes(id)), `Ctrl+V pastes copies with new ids and selects them (${pasted.join(',')})`);
  check(g1.links.some((l) => pasted.includes(l.from.node) && pasted.includes(l.to.node)), 'the wire between copied nodes is pasted too');
  const at = await js(`(() => { const c = document.querySelector('.vs-host:not(.hidden) .vs-canvas').getBoundingClientRect(); const v = ${V}.view(); return { x: (${spot.x} - c.left - v.tx) / v.s, y: (${spot.y} - c.top - v.ty) / v.s }; })()`);
  const corner = { x: Math.min(...g1.nodes.filter((n) => pasted.includes(n.id)).map((n) => n.x)), y: Math.min(...g1.nodes.filter((n) => pasted.includes(n.id)).map((n) => n.y)) };
  check(Math.abs(corner.x - at.x) <= 8 && Math.abs(corner.y - at.y) <= 8, `pasted nodes land at the pointer (${corner.x},${corner.y} vs ${Math.round(at.x)},${Math.round(at.y)})`);
  await press('Ctrl+D');
  await until(`${V}.graph().nodes.length === ${nBefore + 4}`, 'duplicate');
  const dup = (await selection()).split(',');
  const g2 = await graph();
  const src = g2.nodes.find((n) => n.id === pasted[0]);
  const copy = g2.nodes.find((n) => n.id === dup[0]);
  check(dup.length === 2 && copy.x - src.x === 32 && copy.y - src.y === 32, 'Ctrl+D duplicates the selection 32 units down and right');
  await press('Ctrl+Z');
  await press('Ctrl+Z');
  await until(`${V}.graph().nodes.length === ${nBefore}`, 'undo paste and duplicate');
  check(true, 'Ctrl+Z twice undoes the duplicate and the paste');
  await press('Ctrl+Shift+Z');
  await until(`${V}.graph().nodes.length === ${nBefore + 2}`, 'redo paste');
  check(true, 'Ctrl+Shift+Z redoes');
  await press('Ctrl+Z');
  await until(`${V}.graph().nodes.length === ${nBefore}`, 'undo again');
  await focusCanvas();
  await press('Ctrl+A');
  check((await selection()).split(',').length === nBefore, 'Ctrl+A selects every node');

  await click(await head('n6'));
  const h6 = await head('n6');
  await move(h6);
  await mouse('mousePressed', h6, { button: 'right' });
  await mouse('mouseReleased', h6, { button: 'right' });
  await until(`[...document.querySelectorAll('.context-menu .menu-item')].some((e) => e.textContent.includes('Disconnect All'))`, 'node context menu');
  const menuLabels = await js(`[...document.querySelectorAll('.context-menu .menu-item')].map((e) => e.textContent.trim()).filter(Boolean).join(' | ')`);
  check(/Delete/.test(menuLabels) && /Duplicate/.test(menuLabels) && /Disconnect All/.test(menuLabels), `right-clicking a node shows Delete, Duplicate, Disconnect All (${menuLabels})`);
  await click(await js(`(() => { const e = [...document.querySelectorAll('.context-menu .menu-item')].find((x) => x.textContent.includes('Disconnect All')); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`));
  check(!(await graph()).links.some((l) => l.from.node === 'n6' || l.to.node === 'n6'), 'Disconnect All removes every wire of the node');
  await press('Ctrl+Z');
  await until(`${V}.graph().links.some((l) => l.to.node === 'n6')`, 'undo disconnect');

  await js(`(() => { window.__vsChanges = 0; ${V}.onChange((g) => { if (g?.nodes) window.__vsChanges++; }); })()`);
  await click(await center('.vs-host:not(.hidden) .vs-fit'));
  await sleep(100);
  const h9m = await head('n9');
  await move(h9m);
  await mouse('mousePressed', h9m, { button: 'right' });
  await mouse('mouseReleased', h9m, { button: 'right' });
  await until(`[...document.querySelectorAll('.context-menu .menu-item')].some((e) => e.textContent.includes('Edit Text'))`, 'comment menu');
  await click(await js(`(() => { const e = [...document.querySelectorAll('.context-menu .menu-item')].find((x) => x.textContent.includes('Edit Text')); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`));
  check(await js(`document.activeElement?.classList.contains('vs-comment-edit')`), 'Edit Text on a Comment opens its text for editing');
  await press('Ctrl+A');
  const note = 'A note\non two lines';
  await type(note);
  await key('rawKeyDown', 'Enter', 'Enter', 13, 2);
  await key('keyUp', 'Enter', 'Enter', 13, 2);
  await settle();
  check((await nodeOf('n9')).props.text === note && await js(`document.querySelector('.vs-host:not(.hidden) .vs-node[data-id="n9"] .vs-comment-text').textContent`) === note, 'Ctrl+Enter stores the comment text');
  check(await js(`window.__vsChanges`) >= 1, 'onChange listeners hear about edits');

  await press('Ctrl+S');
  await until(`!ide.isDirty(ide.activeTab())`, 'saved');
  const onDisk = readFileSync(demoPath, 'utf8');
  check(onDisk === (await docText()).replace(/\r\n/g, '\n'), 'Ctrl+S writes the document to disk');
  check(VS.serialize(VS.parse(onDisk)) === onDisk, 'the saved file is in the deterministic format (serialize(parse(file)) === file)');
  check(onDisk.includes('"name": "total"') && onDisk.includes('"stop": 5'), 'the saved file has the edits');
  const g3 = VS.parse(onDisk);
  const moved = VS.moveNodes(g3, ['n4'], 160, 0);
  writeFileSync(demoPath, VS.serialize(moved));
  await js(`ide.reloadFromDisk([${S(demoPath)}])`);
  await until(`${V}.graph().nodes.find((n) => n.id === 'n4').x === ${moved.nodes.find((n) => n.id === 'n4').x}`, 'reloaded from disk', 10000);
  await sleep(100);
  check(await js(`document.querySelector('.vs-host:not(.hidden) .vs-node[data-id="n4"]').style.left`) === `${moved.nodes.find((n) => n.id === 'n4').x}px`, 'a change on disk is reloaded and drawn');
  check(!(await dirty()), 'and the file stays clean');

  await click(await head('n9'));
  await press('Delete');
  check(await dirty(), 'an edit makes the tab dirty');
  await press('Ctrl+F4');
  await until(`!!document.querySelector('#dialogHost .dialog')`, 'close dialog');
  const dialogText = await js(`document.querySelector('#dialogHost .dialog').textContent`);
  check(/demo\.pyflow/.test(dialogText), `closing the unsaved tab asks first (${dialogText.slice(0, 80)})`);
  await press('Escape');
  await until(`!document.querySelector('#dialogHost .dialog')`, 'dialog closed');
  check(await js(`!!ide.activeTab()?.visualScript`), 'cancelling keeps the tab open');
  await press('Ctrl+Z');
  await until(`!ide.isDirty(ide.activeTab())`, 'undo back to the saved state');
  check(true, 'undoing back to the saved text makes the tab clean again');

  spot = await emptySpot();
  let v0 = await view();
  await drag(spot, { x: spot.x - 120, y: spot.y - 60 }, { button: 'middle' });
  await sleep(50);
  let v1 = await view();
  check(Math.abs(v1.tx - v0.tx + 120) < 1 && Math.abs(v1.ty - v0.ty + 60) < 1, `middle-drag pans (${(v1.tx - v0.tx).toFixed(0)}, ${(v1.ty - v0.ty).toFixed(0)})`);
  check(!(await dirty()), 'panning does not make the file dirty');
  spot = await emptySpot();
  v0 = v1;
  await drag(spot, { x: spot.x + 80, y: spot.y + 40 }, { button: 'right' });
  await sleep(150);
  v1 = await view();
  const menuAfterPan = await js(`!![...document.querySelectorAll('.context-menu .menu-item')].find((e) => e.textContent.includes('Add Node') && e.offsetParent)`);
  check(Math.abs(v1.tx - v0.tx - 80) < 1 && Math.abs(v1.ty - v0.ty - 40) < 1 && !menuAfterPan, 'right-drag pans without opening the context menu');
  spot = await emptySpot();
  v0 = v1;
  await focusCanvas();
  await key('rawKeyDown', ' ', 'Space', 32);
  await drag(spot, { x: spot.x + 50, y: spot.y + 30 });
  await key('keyUp', ' ', 'Space', 32);
  v1 = await view();
  check(Math.abs(v1.tx - v0.tx - 50) < 1 && Math.abs(v1.ty - v0.ty - 30) < 1, 'Space+drag pans');
  spot = await emptySpot();
  const under = async () => js(`(() => { const c = document.querySelector('.vs-host:not(.hidden) .vs-canvas').getBoundingClientRect(); const v = ${V}.view(); return { x: (${spot.x} - c.left - v.tx) / v.s, y: (${spot.y} - c.top - v.ty) / v.s }; })()`);
  const p0 = await under();
  const zs = (await view()).s;
  await wheel(spot, -120);
  await sleep(60);
  const p1 = await under();
  check((await view()).s > zs && Math.hypot(p1.x - p0.x, p1.y - p0.y) < 0.5, `the wheel zooms around the pointer (${zs.toFixed(2)} -> ${(await view()).s.toFixed(2)}, point moved ${Math.hypot(p1.x - p0.x, p1.y - p0.y).toFixed(2)})`);
  for (let i = 0; i < 15; i++) await wheel(spot, -240);
  await sleep(60);
  check(Math.abs((await view()).s - 2) < 1e-6, 'zoom stops at 200%');
  w = await wiresOnPins();
  check(!w.bad.length, `wires stay on their pins at 200% (${w.bad.join('; ') || 'ok'})`);
  lp = await layoutProblems();
  check(!lp.length, `no overlaps or clipped text at 200% (${lp.slice(0, 3).join('; ') || 'ok'})`);
  for (let i = 0; i < 25; i++) await wheel(spot, 240);
  await sleep(60);
  check(Math.abs((await view()).s - 0.25) < 1e-6, 'zoom stops at 25%');
  await focusCanvas();
  await press('Ctrl+0');
  await sleep(60);
  check(Math.abs((await view()).s - 1) < 1e-6 && await js(`document.querySelector('.vs-host:not(.hidden) .vs-zoom-label').textContent`) === '100%', 'Ctrl+0 resets the zoom to 100%');
  await press('Ctrl+=');
  await sleep(60);
  const zin = (await view()).s;
  await press('Ctrl+-');
  await sleep(60);
  check(Math.abs(zin - 1.2) < 1e-6 && Math.abs((await view()).s - 1) < 1e-6, `Ctrl+= and Ctrl+- zoom in and out on the canvas (${zin.toFixed(2)})`);
  await click(await center('.vs-host:not(.hidden) .vs-fit'));
  await sleep(100);
  const inView = await js(`(() => { const c = document.querySelector('.vs-host:not(.hidden) .vs-canvas').getBoundingClientRect(); return [...document.querySelectorAll('.vs-host:not(.hidden) .vs-node')].every((n) => { const r = n.getBoundingClientRect(); return r.left >= c.left && r.right <= c.right && r.top >= c.top && r.bottom <= c.bottom; }); })()`);
  check(inView, 'Fit shows every node');
  check(!(await dirty()), 'zooming does not make the file dirty');
  await sleep(700);
  check(await js(`ide.settings.get('visualScript.view', {})[${S(demoPath.toLowerCase())}]?.s`) === +((await view()).s.toFixed(4)), 'the view is remembered per file in the visualScript.view setting');

  await js(`ide.openFile(${S(demoPath)}, { asText: true })`);
  await until(`ide.activeTab()?.kind === 'file' && ide.activeTab().path.toLowerCase() === ${S(demoPath.toLowerCase())}`, 'text tab');
  const textEd = 'ide.editor';
  check(await js(`${textEd}.getModel().getValue()`) === readFileSync(demoPath, 'utf8'), 'Open as Text shows the JSON');
  await js(`(() => { const m = ${textEd}.getModel(); const t = m.getValue(); const i = t.indexOf('"stop": 5'); const p = m.getPositionAt(i + 8); ${textEd}.setPosition(p); ${textEd}.focus(); })()`);
  await press('Delete');
  await type('7');
  await sleep(100);
  const vsTab = `ide.tabs.find((t) => t.visualScript)`;
  await until(`${vsTab}.visualScript.graph().nodes.find((n) => n.id === 'n5').inputs.stop === 7`, 'canvas follows the text edit');
  check(await js(`${vsTab}.visualScript.host.querySelector('.vs-node[data-id="n5"] .vs-row:nth-child(2) .vs-field').value`) === '7', 'typing in the text tab re-renders the canvas');
  await js(`(() => { const m = ${textEd}.getModel(); ${textEd}.setPosition(m.getPositionAt(m.getValue().indexOf('"nodes"'))); })()`);
  await type('oops ');
  await sleep(500);
  check(await js(`${vsTab}.visualScript.host.dataset.invalid === 'true' && !${vsTab}.visualScript.host.querySelector('.vs-banner').classList.contains('hidden')`), 'invalid JSON shows a banner over the canvas');
  for (let i = 0; i < 5; i++) await press('Backspace');
  await until(`!${vsTab}.visualScript.host.dataset.invalid`, 'valid again');
  check(await js(`${vsTab}.visualScript.host.querySelector('.vs-banner').classList.contains('hidden')`), 'fixing the text hides the banner and the canvas comes back');
  await js(`ide.openFile(${S(demoPath)})`);
  await until(`!!ide.activeTab()?.visualScript`, 'back on the canvas');
  check(await dirty(), 'the edit made in the text tab is the same unsaved document');

  spot = await emptySpot(NODE_ROOM);
  await move(spot);
  await focusCanvas();
  await press('Tab');
  await until(`document.querySelector('.vs-host:not(.hidden)')?.dataset.palette === 'open'`, 'palette for get var');
  await type('get variable');
  await press('Enter');
  const getId = await js(`${V}.selection()[0]`);
  await js(`(() => { const f = document.querySelector('.vs-host:not(.hidden) .vs-node[data-id="${getId}"] .vs-prop .vs-field'); f.focus(); })()`);
  await press('Ctrl+A');
  await type('missing_name');
  await press('Enter');
  await click(await center('.vs-host:not(.hidden) .vs-fit'));
  await sleep(100);
  await drag(await pin(getId, 'out', 'value'), await pin('n4', 'in', 'value'));
  await until(`document.querySelector('.vs-host:not(.hidden) .vs-node[data-id="${getId}"]')?.classList.contains('vs-err')`, 'error mark', 5000);
  const status = await js(`document.querySelector('.vs-host:not(.hidden) .vs-problems').textContent`);
  check(/^\d+ problems?$/.test(status) && await js(`!!document.querySelector('.vs-host:not(.hidden) .vs-node[data-id="${getId}"] .vs-badge')?.title`), `a compile error outlines the node with a badge and the status counts it (${status})`);
  await click(spot);
  await click(await center('.vs-host:not(.hidden) .vs-problems'));
  check((await selection()) === (await js(`${V}.errors().find((e) => !e.warning && e.node)?.node`)), 'clicking the problems status selects the first node in error');
  await js(`${V}.markRuntimeError('n4', 'NameError: name x is not defined')`);
  check(await js(`document.querySelector('.vs-host:not(.hidden) .vs-node[data-id="n4"]').classList.contains('vs-runtime-err') && document.querySelector('.vs-host:not(.hidden) .vs-node[data-id="n4"] .vs-runtime').textContent.includes('NameError')`), 'markRuntimeError marks a node with the message');
  await press('Delete');
  check(!(await js(`document.querySelector('.vs-host:not(.hidden) .vs-node[data-id="n4"]').classList.contains('vs-runtime-err')`)), 'the next edit clears the runtime mark');

  await openFile(ctx, 'empty.pyflow');
  await until(`document.querySelector('.vs-host:not(.hidden) .vs-node') && ${V}?.graph()?.nodes.length === 1`, 'empty file');
  check((await graph()).nodes[0].type === 'core.start' && !(await dirty()), 'an empty file opens as a new graph with a Start node, still clean');
  await openFile(ctx, 'broken.pyflow');
  await until(`${V}?.host.dataset.invalid === 'true'`, 'broken file');
  await sleep(100);
  check(await js(`!${V}.host.querySelector('.vs-banner').classList.contains('hidden') && /line \\d+/.test(${V}.host.querySelector('.vs-banner-text').textContent)`), 'a broken file shows the parse error with its line and Open as Text');
  await js(`ide.closeTab(ide.activeTab().path, true)`);
  await js(`ide.closeTab(ide.tabs.find((t) => t.path?.endsWith('empty.pyflow')).path, true)`);

  let g200 = VS.newGraph();
  const kinds = ['io.print', 'math.binary', 'var.set'];
  for (let i = 0; i < 199; i++) g200 = VS.addNode(g200, { type: kinds[i % 3], x: 64 + (i % 20) * 256, y: 64 + Math.floor(i / 20) * 192 });
  const execs = g200.nodes.filter((n) => n.type !== 'math.binary');
  for (let i = 1; i < execs.length; i++) g200 = VS.connect(g200, { node: execs[i - 1].id, pin: 'next' }, { node: execs[i].id, pin: 'in' });
  for (const n of g200.nodes.filter((m) => m.type === 'math.binary')) {
    const next = execs.find((m) => VS.compareIds(m.id, n.id) > 0 && m.type !== 'core.start');
    if (next) g200 = VS.connect(g200, { node: n.id, pin: 'result' }, { node: next.id, pin: 'value' });
  }
  writeFileSync(path.join(project, 'big.pyflow'), VS.serialize(g200));
  const t0 = Date.now();
  await openFile(ctx, 'big.pyflow');
  await until(`${V}?.host.dataset.nodes === '200'`, '200 nodes', 30000);
  const openMs = Date.now() - t0;
  const bigLinks = g200.links.length;
  check(await js(`${V}.host.querySelectorAll('.vs-wire').length`) === bigLinks, `a 200-node graph opens with all ${bigLinks} wires (${openMs} ms to open and draw)`);
  await js(`${V}.setView({ s: 1, tx: 0, ty: 0 })`);
  await sleep(200);
  // Frame intervals are capped by vsync, so the main thread's busy time per frame (Performance.getMetrics) says how
  // much headroom is left.
  await cdp('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp('Performance.getMetrics')).result.metrics.map((m) => [m.name, m.value]));
  let m0 = null;
  const startFrames = async () => { m0 = await metrics(); return startFramesJs(); };
  const startFramesJs = () => js(`(() => { window.__frames = []; window.__stop = false; window.__long = 0; let last = performance.now();
    try { window.__obs?.disconnect(); window.__obs = new PerformanceObserver((l) => { window.__long += l.getEntries().length; }); window.__obs.observe({ entryTypes: ['longtask'] }); } catch {}
    const loop = (now) => { window.__frames.push(now - last); last = now; if (!window.__stop) requestAnimationFrame(loop); }; requestAnimationFrame(loop); return true; })()`);
  const stopFrames = async () => {
    const r = await js(`(() => { window.__stop = true; window.__obs?.disconnect(); return { frames: window.__frames.slice(2), long: window.__long }; })()`);
    const m1 = await metrics();
    const per = (k) => ((m1[k] - m0[k]) * 1000) / Math.max(1, r.frames.length);
    return { ...r, busy: per('TaskDuration'), script: per('ScriptDuration'), layout: per('LayoutDuration') + per('RecalcStyleDuration') };
  };
  const stats = ({ frames, long, busy, script, layout }) => {
    const s = [...frames].sort((a, b) => a - b);
    const pct = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
    return { n: s.length, median: pct(0.5), p95: pct(0.95), max: s[s.length - 1], long, busy, script, layout };
  };
  const fmt = (r) => `frame interval median ${r.median.toFixed(1)} ms, p95 ${r.p95.toFixed(1)} ms, max ${r.max.toFixed(1)} ms over ${r.n} frames, ${r.long} long tasks; main thread busy ${r.busy.toFixed(2)} ms per frame (script ${r.script.toFixed(2)}, style+layout ${r.layout.toFixed(2)})`;
  const perf = {};
  spot = await center('.vs-host:not(.hidden) .vs-canvas');
  const txs = new Set();
  await startFrames();
  await move(spot);
  await mouse('mousePressed', spot, { button: 'middle' });
  for (let i = 1; i <= 90; i++) {
    await mouse('mouseMoved', { x: spot.x - (i % 45) * 8, y: spot.y - (i % 45) * 4 }, { button: 'middle' });
    await sleep(16);
    if (i % 10 === 0) txs.add(Math.round((await view()).tx));
  }
  await mouse('mouseReleased', spot, { button: 'middle' });
  perf.pan = stats(await stopFrames());
  check(txs.size >= 5 && perf.pan.median < 25 && perf.pan.p95 < 50, `200 nodes: pan (${txs.size} distinct offsets sampled) ${fmt(perf.pan)}`);
  const scales = [];
  await startFrames();
  for (let i = 0; i < 40; i++) {
    await wheel(spot, i < 20 ? 120 : -120);
    await sleep(16);
    if (i === 19 || i === 39) scales.push((await view()).s);
  }
  perf.zoom = stats(await stopFrames());
  perf.zoom.perStep = (perf.zoom.busy * perf.zoom.n) / 40;
  check(scales[0] < 0.3 && scales[1] > 0.9 && perf.zoom.median < 25 && perf.zoom.p95 < 50,
    `200 nodes: wheel zoom (1 -> ${scales[0].toFixed(2)} -> ${scales[1].toFixed(2)}) ${fmt(perf.zoom)}, ${perf.zoom.perStep.toFixed(1)} ms of main thread per wheel step`);
  await js(`${V}.setView({ s: 1, tx: 0, ty: 0 })`);
  await sleep(100);
  await focusCanvas();
  await press('Ctrl+A');
  const hb = await head('n2');
  const bigVersion = await js(`ide.activeTab().doc.model.getAlternativeVersionId()`);
  await startFrames();
  await move(hb);
  await mouse('mousePressed', hb);
  for (let i = 1; i <= 60; i++) { await mouse('mouseMoved', { x: hb.x + i * 3, y: hb.y + i * 2 }); await sleep(16); }
  await mouse('mouseReleased', { x: hb.x + 180, y: hb.y + 120 });
  perf.drag = stats(await stopFrames());
  check(perf.drag.median < 34 && perf.drag.p95 < 70, `200 nodes: dragging all of them ${fmt(perf.drag)}`);
  await until(`${V}.graph().nodes.find((n) => n.id === 'n2').x !== ${g200.nodes.find((n) => n.id === 'n2').x}`, 'big drag committed');
  check(await js(`ide.activeTab().doc.model.getAlternativeVersionId()`) === bigVersion + 1 && (await graph()).nodes.every((n) => n.x !== g200.nodes.find((m) => m.id === n.id).x), 'dragging all 200 nodes moves every one of them in one edit');
  console.log(`FRAMES ${S(perf)}`);
  await js(`ide.closeTab(ide.activeTab().path, true)`);

  // ---- the palette ranks a whole keyword above a name's start; fields keep what is typed ----
  let fg = VS.newGraph();
  fg = VS.addNode(fg, { id: 'n2', type: 'io.print', x: 320, y: 112 });
  fg = VS.addNode(fg, { id: 'n3', type: 'math.binary', x: 320, y: 300 });
  fg = VS.connect(fg, { node: 'n1', pin: 'next' }, { node: 'n2', pin: 'in' });
  const fieldsPath = path.join(project, 'fields.pyflow');
  writeFileSync(fieldsPath, VS.serialize(fg));
  await openFile(ctx, 'fields.pyflow');
  await until(`${V}?.host.dataset.nodes === '3'`, 'fields.pyflow');
  await js(`(${V}.fit(), new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))`);
  for (const [query, type] of [['input', 'io.input'], ['print', 'io.print'], ['ask', 'io.input']]) {
    await focusCanvas();
    await press('Tab');
    await until(`document.querySelector('.vs-host:not(.hidden)')?.dataset.palette === 'open'`, 'palette');
    await ctx.type(query);
    await until(`document.querySelector('.vs-host:not(.hidden) .vs-pal-item.vs-active')?.dataset.type === ${S(type)} && document.querySelector('.vs-host:not(.hidden) .vs-pal-item')?.dataset.type === ${S(type)}`, `${query} ranks ${type} first`)
      .catch(async (err) => { throw new Error(`${err.message}: ${S(await js(`[...document.querySelectorAll('.vs-host:not(.hidden) .vs-pal-item')].slice(0, 4).map((r) => r.dataset.type)`))}`); });
    check(true, `typing "${query}" puts ${type} first in the palette, so Enter adds it`);
    await press('Escape');
  }
  const printField = '.vs-host:not(.hidden) .vs-node[data-id="n2"] .vs-field';
  const aField = '.vs-host:not(.hidden) .vs-node[data-id="n3"] .vs-row:nth-child(1) .vs-field';
  const typeInto = async (selector, text) => { await click(await center(selector)); await press('Ctrl+A'); await ctx.type(text); };
  for (const text of ['01012345678', '12345678901234567890']) {
    await typeInto(printField, text);
    await press('Enter');
    await settle();
    check((await nodeOf('n2')).inputs.value === text && await js(`document.querySelector(${S(printField)}).value`) === text,
      `an "any" field keeps ${text} as the text typed, not a rounded number`);
  }
  await typeInto(aField, '12345678901234567890');
  await press('Enter');
  await settle();
  check((await nodeOf('n3')).inputs.a === '12345678901234567890' && await js(`PyideVisualScript.compile(${V}.graph()).pinExpr.n3.result`) === '12345678901234567890 + 0',
    'a Number field keeps a 20-digit integer exact, and the code has it as typed');

  await typeInto(printField, 'saved while typing');
  await press('Ctrl+S');
  await until(`!ide.isDirty(ide.activeTab())`, 'saved');
  check(readFileSync(fieldsPath, 'utf8').includes('"value": "saved while typing"'), 'Ctrl+S while typing in a field saves what was typed');
  check(await js(`document.activeElement?.matches(${S(printField)}) && document.activeElement.selectionStart === 'saved while typing'.length`), 'and the keyboard stays in the field, at the end of the text');
  await press('Ctrl+A');
  await ctx.type('typed before closing');
  check(!(await dirty()), 'typing alone does not write the document yet');
  await press('Ctrl+F4');
  await until(`!!document.querySelector('#dialogHost .dialog')`, 'the close question')
    .catch(async (err) => { throw new Error(`${err.message}: tab ${await js(`ide.activeTab()?.path`)}`); });
  check(/fields\.pyflow/.test(await js(`document.querySelector('#dialogHost .dialog').textContent`)) && (await docText()).includes('typed before closing'),
    'Ctrl+F4 while typing in a field writes it first, so the tab asks before closing and nothing is lost');
  await press('Escape');
  await until(`!document.querySelector('#dialogHost .dialog')`, 'kept open');
  check(await js(`!!ide.activeTab()?.visualScript && document.activeElement?.matches(${S(printField)}) && document.activeElement.value === 'typed before closing'`), 'Cancel keeps the tab, the text and the keyboard in the field');
  await press('Escape');
  await js(`ide.closeTab(ide.activeTab().path, true)`);

  await openFile(ctx, 'demo.pyflow');
  await until(`${V}?.host.dataset.nodes`, 'demo again');
  await js(`ide.settings.set('appearance.theme', 'light')`);
  await until(`document.documentElement.dataset.theme === 'light'`, 'light theme');
  await click(await center('.vs-host:not(.hidden) .vs-fit'));
  await sleep(300);
  const light = await js(`(() => {
    const rgb = (c) => (c.match(/[\\d.]+/g) || []).slice(0, 3).map((x) => (c.startsWith('color(srgb') ? Number(x) * 255 : Number(x)));
    const lum = (c) => { const v = rgb(c).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const host = document.querySelector('.vs-host:not(.hidden)');
    const canvasBg = getComputedStyle(host.querySelector('.vs-canvas')).backgroundColor;
    const node = host.querySelector('.vs-node[data-id="n4"]');
    const headEl = node.querySelector('.vs-head');
    const title = node.querySelector('.vs-title');
    const label = node.querySelector('.vs-label');
    const exec = host.querySelector('.vs-wire-exec');
    return {
      canvasBg, nodeBg: getComputedStyle(node).backgroundColor,
      title: contrast(getComputedStyle(title).color, getComputedStyle(headEl).backgroundColor),
      label: contrast(getComputedStyle(label).color, getComputedStyle(node).backgroundColor),
      wire: contrast(getComputedStyle(exec).stroke, canvasBg),
      canvasLum: lum(canvasBg),
    };
  })()`);
  check(light.canvasLum > 0.8 && light.canvasBg !== light.nodeBg, `Light theme: a light canvas with nodes set off from it (${light.canvasBg} / ${light.nodeBg})`);
  check(light.title >= 4.5 && light.label >= 4.5, `Light theme: titles and labels are readable (contrast ${light.title.toFixed(1)}, ${light.label.toFixed(1)})`);
  check(light.wire >= 3, `Light theme: exec wires stand out from the canvas (contrast ${light.wire.toFixed(1)})`);
  lp = await layoutProblems();
  check(!lp.length, `Light theme: no overlaps or clipped text (${lp.slice(0, 3).join('; ') || 'ok'})`);
  await shot('light.png');
  await js(`ide.settings.set('appearance.theme', 'dark')`);
} catch (err) {
  check(false, `suite error: ${err.message}`);
  await shot('failure.png').catch(() => {});
}
ctx.finish();
