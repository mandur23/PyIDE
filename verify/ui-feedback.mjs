// What a press shows: a button with an icon alone has it in its middle; dragging a splitter resizes its panel
// without selecting the text it passes over (a cover takes the pointer for the length of the drag); and a Refresh
// button turns its icon while its refresh runs, for long enough to be seen. Port 9945.
import { launch, openFile } from './lib.mjs';

const t = await launch({ fixture: 'core', port: 9945, name: 'ui-feedback' });
const { js, until, check, cdp, sleep } = t;
const S = JSON.stringify;
const mouse = (type, x, y, buttons = 0) => cdp('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: 1 });
// Icon-only buttons on screen whose icon is more than a pixel and a quarter from their middle.
const OFF_CENTRE = `(() => [...document.querySelectorAll('button')].map((b) => {
  const icon = b.querySelector('svg, .ide-icon'); if (!icon || b.textContent.trim()) return null;
  const r = b.getBoundingClientRect(); const i = icon.getBoundingClientRect(); if (r.width < 2 || i.width < 2) return null;
  const dx = i.left + i.width / 2 - (r.left + r.width / 2); const dy = i.top + i.height / 2 - (r.top + r.height / 2);
  return Math.abs(dx) > 1.25 || Math.abs(dy) > 1.25 ? (b.title || b.dataset.tooltip || b.className) + ' ' + dx.toFixed(1) + ',' + dy.toFixed(1) : null;
}).filter(Boolean))()`;
try {
  await until(`document.querySelector('#tree .node')`, 'project tree');
  await openFile(t, 'hello.py');

  // ---------- icons in the middle of their buttons ----------
  const off = [];
  for (const id of await js(`[...ide.toolWindows.keys()]`)) {
    await js(`(ide.toolWindows.get(${S(id)}).show(), true)`);
    await sleep(250);
    off.push(...(await js(OFF_CENTRE)).map((x) => `${id}: ${x}`));
  }
  check(!off.length, `every icon button of every tool window has its icon in its middle${off.length ? `: ${off.join(' | ')}` : ''}`);

  // ---------- dragging a splitter ----------
  await js(`(ide.toolWindows.get('Project').show(), true)`);
  await sleep(300);
  const box = await js(`(() => { const r = document.querySelector('#sideSplitter').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: document.querySelector('#sidePanel').offsetWidth }; })()`);
  await mouse('mouseMoved', box.x, box.y);
  await mouse('mousePressed', box.x, box.y, 1);
  for (let i = 1; i <= 6; i++) await mouse('mouseMoved', box.x + i * 20, box.y - i * 15, 1);
  const during = await js(`(() => ({ cover: !!document.querySelector('.drag-cover'), resizing: document.body.classList.contains('resizing'), selected: String(getSelection()),
    dragging: document.querySelector('#sideSplitter').classList.contains('dragging'), w: document.querySelector('#sidePanel').offsetWidth,
    over: document.elementFromPoint(${box.x} + 120, ${box.y} - 90)?.className }))()`);
  check(during.cover && during.resizing && during.dragging && during.over === 'drag-cover', `while a splitter is dragged a cover takes the pointer over the whole window (${S(during)})`);
  check(during.selected === '', `the drag selects no text on its way (${S(during.selected)})`);
  check(Math.abs(during.w - box.w - 120) <= 2, `the panel follows the pointer: ${box.w} to ${during.w} px for 120 px`);
  await mouse('mouseReleased', box.x + 120, box.y - 90);
  const after = await js(`(() => ({ cover: !!document.querySelector('.drag-cover'), resizing: document.body.classList.contains('resizing'), dragging: document.querySelector('#sideSplitter').classList.contains('dragging'), w: document.querySelector('#sidePanel').offsetWidth }))()`);
  check(!after.cover && !after.resizing && !after.dragging && after.w === during.w, `letting go ends it and keeps the size (${S(after)})`);
  // A drag that ends outside the window (the window loses the pointer) ends too.
  const again = await js(`(() => { const r = document.querySelector('#sideSplitter').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await mouse('mousePressed', again.x, again.y, 1);
  await mouse('mouseMoved', again.x - 40, again.y, 1);
  await js(`(window.dispatchEvent(new Event('blur')), true)`);
  check(await js(`!document.querySelector('.drag-cover') && !document.body.classList.contains('resizing')`), 'a drag ends when the window loses the pointer');
  await mouse('mouseReleased', again.x - 40, again.y);

  // ---------- a Refresh button shows that it is working ----------
  // A tool window's header action: working for as long as its action takes.
  const slow = await js(`(() => { const b = document.createElement('button'); b.id = 'slowRefresh'; b.appendChild(ide.icon('refresh')); document.querySelector('#statusbar, body').appendChild(b);
    ide.ui.working(b, new Promise((r) => { window.__done = r; })); return b.classList.contains('working') && b.getAttribute('aria-busy') === 'true'; })()`);
  await sleep(900);
  const spinning = await js(`(() => { const b = document.querySelector('#slowRefresh'); return { working: b.classList.contains('working'), animation: getComputedStyle(b.querySelector('[data-icon-name="refresh"]')).animationName }; })()`);
  check(slow && spinning.working && spinning.animation === 'ide-spin', `a button whose work takes long turns its refresh icon until the work ends (${S(spinning)})`);
  await js(`(window.__done(), true)`);
  await until(`!document.querySelector('#slowRefresh').classList.contains('working')`, 'the turning ends with the work', 3000);
  check(await js(`!document.querySelector('#slowRefresh').hasAttribute('aria-busy')`), 'and the button is no longer busy');
  // Any Refresh button, pressed: it shows the press for a moment even when its refresh takes no time.
  const quick = await js(`(() => { const b = document.querySelector('#slowRefresh'); const at = performance.now(); b.click(); window.__pressed = at; return b.classList.contains('working'); })()`);
  await until(`!document.querySelector('#slowRefresh').classList.contains('working')`, 'the quick press ends', 3000);
  const took = await js(`performance.now() - window.__pressed`);
  check(quick && took >= 550, `a pressed Refresh button shows it for at least 600 ms (${Math.round(took)} ms)`);
  const sheen = await js(`(() => { const b = document.createElement('button'); b.textContent = 'Reload'; b.className = 'reload-test'; document.body.appendChild(b); b.click();
    const s = getComputedStyle(b); const r = { working: b.classList.contains('working'), animation: s.animationName }; return r; })()`);
  check(sheen.working && sheen.animation === 'ide-sheen', `a text button that reloads gets a moving sheen (${S(sheen)})`);
  await js(`(document.querySelector('#slowRefresh').remove(), document.querySelector('.reload-test').remove(), true)`);
  check(t.consoleErrors.length === 0, `no renderer exceptions${t.consoleErrors.length ? ` ${S(t.consoleErrors)}` : ''}`);
} catch (err) {
  check(false, err.message);
}
t.finish();
