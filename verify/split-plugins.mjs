// Plugins in a split editor: breakpoints, the execution line, run gutter icons, Ctrl+B, navigation history, git
// change markers, the annotate context action and editor settings all work in the second pane, driven by real input.
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch, lensesShown, openFile } from './lib.mjs';

// Isolate git from the user's global/system config, as verify/vcs.mjs does.
const gitHome = mkdtempSync(path.join(tmpdir(), 'pyide-split-git-'));
const gitConfig = path.join(gitHome, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Alice\n\temail = alice@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const t = await launch({ fixture: 'split-plugins', port: 9470 });
const { js, press, type, check, shot, cdp, sleep, project } = t;
const q = JSON.stringify;

// An occluded window gets no animation frames; a tiny screenshot forces one so Monaco paints its DOM.
const frame = () => cdp('Page.captureScreenshot', { format: 'jpeg', quality: 1 });
async function until(expr, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await frame();
    try { if (await js(expr)) return true; } catch {}
    await sleep(150);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

const LEFT = 0;
const RIGHT = 1;
const ed = (i) => `ide.groups()[${i}].editor`;
const dom = (i) => `ide.groups()[${i}].el`;
// Renders both panes synchronously, then counts matching nodes inside one pane.
const count = (i, sel) => `(ide.editors().forEach(e => e.render(true)), ${dom(i)}.querySelectorAll(${q(sel)}).length)`;
const rightIsActive = `ide.activeGroup()?.editor === ${ed(RIGHT)}`;

async function mouseAt(p, button = 'left', move = true) {
  await frame();
  if (move) { await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); await sleep(80); }
  for (const kind of ['mousePressed', 'mouseReleased']) {
    await cdp('Input.dispatchMouseEvent', { type: kind, x: p.x, y: p.y, button, clickCount: 1, buttons: button === 'left' ? 1 : 2 });
  }
  await sleep(120);
}
// Screen point of a pane's glyph margin, or of a text position, on a line.
const glyphPoint = (i, line) => js(`(() => { const e = ${ed(i)}; e.revealLineInCenterIfOutsideViewport(${line}); e.render(true);
  const li = e.getLayoutInfo(); const pos = e.getScrolledVisiblePosition({ lineNumber: ${line}, column: 1 }); const r = e.getDomNode().getBoundingClientRect();
  return { x: r.left + li.glyphMarginLeft + li.glyphMarginWidth / 2, y: r.top + pos.top + pos.height / 2 }; })()`);
const textPoint = (i, line, col) => js(`(() => { const e = ${ed(i)}; e.revealLineInCenterIfOutsideViewport(${line}); e.render(true);
  const pos = e.getScrolledVisiblePosition({ lineNumber: ${line}, column: ${col} }); const r = e.getDomNode().getBoundingClientRect();
  return { x: r.left + pos.left + 2, y: r.top + pos.top + pos.height / 2 }; })()`);
const caretOf = (i) => js(`(() => { const p = ${ed(i)}.getPosition(); return p && p.lineNumber + ':' + p.column; })()`);
const fileOf = (i) => js(`(() => { const m = ${ed(i)}.getModel(); return m ? m.uri.path.split('/').pop() : null; })()`);
const bpLines = () => js(`window.__debugger.breakpoints().filter(b => b.path.endsWith('main.py')).map(b => b.line).join()`);
const menuItems = () => js(`[...document.querySelectorAll('.context-menu .menu-item')].map(n => n.textContent)`);
// Monaco's context menu may live in a shadow root.
const monacoMenuItem = (label) => `(() => { const roots = [document, ...[...document.querySelectorAll('*')].filter(e => e.shadowRoot).map(e => e.shadowRoot)];
  for (const r of roots) for (const a of r.querySelectorAll('.monaco-menu .action-label')) if (a.textContent.trim() === ${q(label)}) return a; return null; })()`;

try {
  // ---- split right, then work in the right pane ----
  await openFile(t, 'main.py');
  await js(`ide.runAction('SplitVertically')`);
  await until(`ide.groups().length === 2 && ${ed(RIGHT)}.getModel() === ${ed(LEFT)}.getModel()`, 'split right');
  check(true, 'Split Right shows main.py in a second pane');
  // Code vision's lens above compute() pushes its lines down a moment after each pane shows the file: positions are
  // taken once it is there.
  await until(`${lensesShown(ed(LEFT))} && ${lensesShown(ed(RIGHT))}`, 'code lenses in both panes');
  // Focus the left pane, then click into the right one, as a user would.
  await mouseAt(await textPoint(LEFT, 2, 1));
  await until(`ide.activeGroup()?.editor === ${ed(LEFT)}`, 'left pane focused');
  await mouseAt(await textPoint(RIGHT, 2, 1));
  await until(rightIsActive, 'right pane focused');
  check(true, 'clicking the right pane makes it the active editor');

  // ---- breakpoint from the right pane's glyph margin ----
  const g5 = await glyphPoint(RIGHT, 5);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g5.x, y: g5.y });
  await until(`${count(RIGHT, '.dbg-bp.hover')} === 1`, 'hover dot in right pane');
  check(await js(`${count(LEFT, '.dbg-bp.hover')} === 0`), 'the breakpoint hover dot shows only in the pane under the mouse');
  await mouseAt(await glyphPoint(RIGHT, 7));
  await until(`${count(RIGHT, '.dbg-bp:not(.hover)')} === 1 && ${count(LEFT, '.dbg-bp:not(.hover)')} === 1`, 'red dot in both panes');
  check((await bpLines()) === '7', 'clicking the right pane\'s glyph margin adds a breakpoint on line 7, shown in both panes');
  await mouseAt(await glyphPoint(RIGHT, 13));
  await mouseAt(await glyphPoint(RIGHT, 13));
  check((await bpLines()) === '7', 'a second click in the right pane removes the breakpoint it added');

  // ---- run gutter icon in the right pane ----
  const iconExpr = (i, line) => `(() => { const e = ${ed(i)}; e.revealLineInCenterIfOutsideViewport(${line}); e.render(true);
    const top = e.getTopForLineNumber(${line}) - e.getScrollTop(); const host = e.getDomNode().getBoundingClientRect();
    const n = [...${dom(i)}.querySelectorAll('.run-gutter-icon')].find(n => Math.abs(n.getBoundingClientRect().top - host.top - top) < 4);
    if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`;
  await until(iconExpr(RIGHT, 11), 'run icon in right pane');
  check(!!(await js(iconExpr(LEFT, 11))), 'the run icon on the __main__ line shows in both panes');
  await mouseAt(await js(iconExpr(RIGHT, 11)));
  await until(`document.querySelectorAll('.context-menu .menu-item').length > 0`, 'gutter menu');
  const gm = await menuItems();
  check(gm.some((s) => s.includes("Run 'main'")), `clicking the right pane's run icon opens its menu (${gm.join(' | ')})`);
  check((await bpLines()) === '7', 'clicking the run icon does not toggle a breakpoint');

  // ---- debugger: execution line in both panes ----
  // Clicking into the right pane's text also dismisses the gutter menu.
  await mouseAt(await textPoint(RIGHT, 2, 1));
  await until(`!document.querySelector('.context-menu .menu-item')`, 'menu closed');
  await until(rightIsActive, 'right pane focused');
  await press('Shift+F9');
  await until(`(() => { const s = window.__debugger.state(); const f = s?.state === 'suspended' && s.frames[s.frameIdx]; return f && f.path?.endsWith('main.py') && f.line === 7; })()`, 'suspended at main.py:7', 40000);
  await until(`${count(RIGHT, '.dbg-exec-line')} === 1 && ${count(LEFT, '.dbg-exec-line')} === 1`, 'execution line in both panes');
  check(true, 'the debugger\'s execution line shows in both panes');
  await until(`${count(RIGHT, '.dbg-inline-val')} > 0 && ${count(LEFT, '.dbg-inline-val')} > 0`, 'inline values in both panes');
  check(true, 'inline values show in both panes');
  await shot('split-debug.png');
  await js(`ide.runAction('StopDebug')`);
  await until(`window.__debugger.state() === null && ${count(RIGHT, '.dbg-exec-line')} === 0`, 'debug session ended', 20000);
  check(true, 'stopping the session clears the execution line');

  // ---- LSP Ctrl+B in the right pane, then Back ----
  await until(`ide.lsp.status() === 'ready'`, 'pyright ready', 60000);
  await mouseAt(await textPoint(RIGHT, 7, 19));
  await until(`${rightIsActive} && ${ed(RIGHT)}.getPosition().lineNumber === 7`, 'caret on scale(v) in right pane');
  await press('Ctrl+B');
  await until(`${ed(RIGHT)}.getModel()?.uri.path.endsWith('helper.py')`, 'helper.py opened by Ctrl+B', 20000);
  check(await js(rightIsActive), 'Ctrl+B keeps the right pane active');
  check((await fileOf(RIGHT)) === 'helper.py' && (await caretOf(RIGHT)) === '1:5', `Ctrl+B navigates inside the right pane (${await fileOf(RIGHT)} ${await caretOf(RIGHT)})`);
  check((await fileOf(LEFT)) === 'main.py', 'the left pane still shows main.py');
  await press('Ctrl+Alt+ArrowLeft');
  await until(`${ed(RIGHT)}.getModel()?.uri.path.endsWith('main.py')`, 'back to main.py');
  check(await js(rightIsActive) && (await caretOf(RIGHT)).startsWith('7:'), `Back (Ctrl+Alt+Left) returns the right pane to main.py:7 (${await caretOf(RIGHT)})`);
  await press('Ctrl+Alt+ArrowRight');
  await until(`${ed(RIGHT)}.getModel()?.uri.path.endsWith('helper.py')`, 'forward to helper.py');
  check(true, 'Forward (Ctrl+Alt+Right) goes to helper.py again in the right pane');
  await press('Ctrl+Alt+ArrowLeft');
  await until(`${ed(RIGHT)}.getModel()?.uri.path.endsWith('main.py')`, 'back to main.py again');

  // ---- settings: font size applies to every pane ----
  await js(`ide.openSettings('editor')`);
  await until(`!!document.querySelector('[data-key="editor.fontSize"]')`, 'editor settings page');
  await t.click('[data-key="editor.fontSize"]');
  await js(`document.querySelector('[data-key="editor.fontSize"]').select()`);
  await type('17');
  await t.click('#settingsApply');
  const fonts = () => js(`ide.editors().map(e => e.getOption(ide.monaco.editor.EditorOption.fontSize)).join()`);
  await until(`ide.editors().every(e => e.getOption(ide.monaco.editor.EditorOption.fontSize) === 17)`, 'font in both panes');
  check((await fonts()) === '17,17', 'Settings font size applies to both panes');
  await press('Escape');
  await until(`!document.querySelector('.settings-dialog')`, 'settings closed');

  // ---- git change markers and the annotate context action in the right pane ----
  git(project, 'init');
  git(project, 'add', '-A');
  git(project, 'commit', '-m', 'Initial commit');
  await js(`window.dispatchEvent(new Event('focus'))`);
  await until(`document.querySelector('.vcs-branch-name')?.textContent === 'main'`, 'repository detected');
  await mouseAt(await textPoint(RIGHT, 5, 14));
  await until(`${rightIsActive} && ${ed(RIGHT)}.getPosition().lineNumber === 5 && ${ed(RIGHT)}.getPosition().column === 14`, 'caret at the end of line 5 in right pane');
  await type('  # changed');
  await until(`${count(RIGHT, '.vcs-modified')} === 1`, 'modified marker in right pane');
  check(true, 'typing in the right pane shows a git change marker there');
  check(await js(`${count(LEFT, '.vcs-modified')} === 1`), 'the left pane shows the same marker');
  await shot('split-view.png');

  const tp = await textPoint(RIGHT, 2, 1);
  await mouseAt(tp, 'right');
  await until(`!!${monacoMenuItem('Annotate with Git Blame')}`, 'annotate in right pane context menu');
  check(await js(`!${monacoMenuItem('Annotate with Git Blame')}.closest('.action-item').classList.contains('disabled')`), 'the right pane\'s context menu offers an enabled "Annotate with Git Blame"');
  const before = await js(`${ed(RIGHT)}.getLayoutInfo().decorationsWidth`);
  await mouseAt(await js(`(() => { const r = ${monacoMenuItem('Annotate with Git Blame')}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`));
  await until(`${count(RIGHT, '.vcs-blame')} >= 3`, 'blame in right pane');
  check(await js(`${ed(RIGHT)}.getLayoutInfo().decorationsWidth`) > before + 30, 'annotating from the right pane widens its gutter');
  check(await js(`${count(LEFT, '.vcs-blame')} >= 3 && ${ed(LEFT)}.getLayoutInfo().decorationsWidth > ${before} + 30`), 'the left pane, showing the same file, is annotated and widened too');
  await shot('split-blame.png');
  // The text moved right with the wider gutter.
  await mouseAt(await textPoint(RIGHT, 2, 1), 'right');
  await until(`!!${monacoMenuItem('Close Annotations')}`, 'close annotations item');
  await mouseAt(await js(`(() => { const r = ${monacoMenuItem('Close Annotations')}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`));
  await until(`${count(RIGHT, '.vcs-blame')} === 0 && ${count(LEFT, '.vcs-blame')} === 0`, 'annotations closed');
  check(true, 'Close Annotations from the right pane clears both panes');

  // ---- a pane created later gets the same plugin behavior ----
  await js(`ide.runAction('SplitHorizontally')`);
  await until(`ide.groups().length === 3`, 'third pane');
  await until(lensesShown(ed(2)), 'code lenses in the third pane');
  check(await js(`ide.editors()[2].getOption(ide.monaco.editor.EditorOption.fontSize) === 17`), 'a new pane gets the font size setting');
  // The new pane is short (the Debug window is open below it) and the lens above compute() takes room too, so the
  // marked lines 5-7 are scrolled into view first: Monaco draws decorations only on the lines it renders.
  await until(`(${ed(2)}.revealLinesInCenterIfOutsideViewport(5, 7), ${count(2, '.dbg-bp:not(.hover)')} === 1 && ${count(2, '.vcs-modified')} === 1)`, 'decorations in third pane');
  check(true, 'a new pane shows the breakpoint and the change marker');
  await mouseAt(await glyphPoint(2, 8));
  check((await bpLines()) === '7,8', 'the new pane\'s glyph margin toggles breakpoints');
  await until(`${count(LEFT, '.dbg-bp:not(.hover)')} === 2`, 'new breakpoint in left pane');
} catch (err) {
  check(false, err.message.split('\n')[0]);
  await shot('failure.png').catch(() => {});
}
t.finish();
