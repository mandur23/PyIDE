// Collaboration step 2 (docs/collab-coding-plan.md): editing together. A guest who joined view only gets the right to
// edit from the host's Collaboration tool window, then both type into the same file at once with real keys and end
// with the same text; Ctrl+Z and Ctrl+Shift+Z undo and redo only one's own typing; each sees the other's caret,
// selection and name tag where the other is; the guest follows the host into another file and down it; the host takes
// the right to edit back and finally removes the guest, whose copy goes. Two app instances on loopback through a stand-in bore. Ports 9457 (host), 9458 (guest).
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { collabPair, sleep } from './collab-lib.mjs';

const pair = await collabPair({ name: 'collab-edit', ports: [9457, 9458] });
const { h, g, check, section, pressButton, pressNode } = pair;
const S = JSON.stringify;
const hp = (n) => path.join(h.project, n);
const hostText = (n) => `ide.getDocument(${S(hp(n))})?.model.getValue()`;
const guestText = (n) => `ide.getDocument(ide.collab.localPath(${S(n)}))?.model.getValue()`;
const lf = (s) => (s || '').replace(/\r\n/g, '\n');

try {
  writeFileSync(hp('shared.py'), ['def greet(name):', '    return name', '', 'print(greet("x"))', ''].join('\r\n'));
  writeFileSync(hp('long.py'), Array.from({ length: 300 }, (_, i) => `line_${i + 1} = ${i + 1}`).join('\n') + '\n');
  await h.js(`ide.openFile(${S(hp('shared.py'))})`);
  const code = await pair.start({ name: 'Hana' });
  await pair.join(code, { name: 'Min', answer: 'Accept (View Only)' });
  await g.until(`[...document.querySelectorAll('.collab-tree-row')].some((r) => r.dataset.rel === 'shared.py')`, 'the guest\'s tree');
  await pressNode(g, `[...document.querySelectorAll('.collab-tree-row')].find((x) => x.dataset.rel === 'shared.py')`, 'shared.py');
  await g.until(`(${guestText('shared.py')} || '').includes('def greet')`, 'the guest shows shared.py', 15000);

  await section('the host lets the guest edit', async () => {
    check(await g.js(`ide.editor.getOption(ide.monaco.editor.EditorOption.readOnly)`), 'the guest starts view only');
    await pressNode(h, `document.querySelector('.collab-person[data-id="1"] .collab-role')`, 'Allow Editing');
    await g.until(`ide.collab.canEdit() && !ide.editor.getOption(ide.monaco.editor.EditorOption.readOnly)`, 'the guest may edit', 10000);
    check(true, 'Allow Editing in the host\'s list makes the guest\'s editor writable');
    check(await h.js(`document.querySelector('.collab-person[data-id="1"] .collab-person-role').textContent === 'Can edit'`), 'the host\'s list says the guest can edit');
    check(await g.js(`ide.notifications.list().some((n) => n.title === 'You may now edit')`), 'the guest is told');
  });

  await section('both type at once', async () => {
    // The host at the start of the file, the guest at its end, at the same moment, with real key events.
    await h.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 1, column: 1 }), true)`);
    await g.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 5, column: 1 }), true)`);
    const typing = async (ctx, word) => { for (let i = 0; i < 12; i++) { await ctx.type(`${word}${i} `); if (i % 4 === 3) await ctx.press('Enter'); } };
    await Promise.all([typing(h, 'H'), typing(g, 'G')]);
    await h.until(`(() => { const a = ${hostText('shared.py')}; return ['H11', 'G11'].every((w) => a.includes(w)); })()`, 'the host has both', 20000);
    await g.until(`(() => { const a = ${guestText('shared.py')}; return ['H11', 'G11'].every((w) => a.includes(w)); })()`, 'the guest has both', 20000);
    await sleep(500);
    const [a, b] = [await h.js(hostText('shared.py')), await g.js(guestText('shared.py'))];
    check(lf(a) === lf(b), 'host and guest end with the same text');
    const words = (prefix) => Array.from({ length: 12 }, (_, i) => `${prefix}${i} `);
    check(words('H').every((w) => a.includes(w)) && words('G').every((w) => a.includes(w)), 'no keystroke of either is lost');
    check(lf(a).includes('def greet(name):') && lf(a).startsWith('H0 '), 'the host\'s text went where it typed, the file around it intact');
    check(await h.js(`ide.getDocument(${S(hp('shared.py'))}).model.getEOL() === '\\r\\n'`) && await g.js(`ide.getDocument(ide.collab.localPath('shared.py')).model.getEOL() === '\\r\\n'`), 'both keep the file\'s CRLF');
    check(!readFileSync(hp('shared.py'), 'utf8').includes('G11'), 'nothing is saved until someone saves');
  });

  // A word is one undo step, as Monaco groups typing (it ends a step before a space).
  await section('Ctrl+Z undoes only one\'s own typing', async () => {
    const both = async (pred, label) => {
      await h.until(`(() => { const t = ${hostText('shared.py')}; return ${pred}; })()`, `host: ${label}`, 10000);
      await g.until(`(() => { const t = ${guestText('shared.py')}; return ${pred}; })()`, `guest: ${label}`, 10000);
    };
    await h.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 1, column: 1 }), true)`);
    await h.type('HOSTUNDO');
    await g.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 2, column: 1 }), true)`);
    await g.type('GUESTUNDO');
    await both(`t.includes('HOSTUNDO') && t.includes('GUESTUNDO')`, 'both edits');
    const before = await h.js(hostText('shared.py'));
    await h.press('Ctrl+z');
    await both(`!t.includes('HOSTUNDO') && t.includes('GUESTUNDO')`, 'the host\'s typing undone, the guest\'s kept');
    check(lf(await h.js(hostText('shared.py'))) === lf(before).replace('HOSTUNDO', ''), 'the host\'s Ctrl+Z takes out only what the host typed, in both apps');
    await g.press('Ctrl+z');
    await both(`!t.includes('HOSTUNDO') && !t.includes('GUESTUNDO')`, 'the guest\'s typing undone');
    check(lf(await g.js(guestText('shared.py'))) === lf(before).replace('HOSTUNDO', '').replace('GUESTUNDO', ''), 'the guest\'s Ctrl+Z takes out only what the guest typed');
    const now = await h.js(hostText('shared.py'));
    check(['H11 ', 'G11 '].every((w) => now.includes(w)), 'the earlier typing of both stays');
    await g.press('Ctrl+Shift+z');
    await both(`t.includes('GUESTUNDO') && !t.includes('HOSTUNDO')`, 'the guest redid its typing');
    check(true, 'Ctrl+Shift+Z redoes the guest\'s typing, not the host\'s');
    await h.press('Ctrl+Shift+z');
    await both(`t.includes('GUESTUNDO') && t.includes('HOSTUNDO')`, 'the host redid its typing');
    check(lf(await h.js(hostText('shared.py'))) === lf(await g.js(guestText('shared.py'))), 'both apps end with the same text');
  });

  await section('carets, selections and name tags', async () => {
    // The guest selects five characters on line 2; the host sees the selection and Min's tag there.
    await g.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 2, column: 1 }), true)`);
    for (let i = 0; i < 5; i++) await g.press('Shift+ArrowRight');
    await h.until(`!!document.querySelector('.monaco-editor .collab-sel') && [...document.querySelectorAll('.collab-tag')].some((t) => t.textContent === 'Min')`, 'the host sees Min\'s selection and tag', 10000);
    const sel = await h.js(`(() => { const m = ide.getDocument(${S(hp('shared.py'))}).model; const d = m.getAllDecorations().find((x) => x.options.className?.includes('collab-sel')); return d && m.getValueInRange(d.range); })()`);
    const guestSel = await g.js(`ide.editor.getModel().getValueInRange(ide.editor.getSelection())`);
    check(sel === guestSel && sel.length === 5, `the host draws the guest's selection over the same text (${S(sel)})`);
    const tag = await h.js(`(() => { const t = [...document.querySelectorAll('.collab-tag')].find((x) => x.textContent === 'Min'); const r = t.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; })()`);
    check(tag.w > 10 && await h.js(`document.elementFromPoint(${tag.x}, ${tag.y})?.closest('.monaco-editor') !== null`), 'Min\'s name tag is on screen in the host\'s editor');
    check(await h.js(`getComputedStyle(document.querySelector('.collab-tag')).backgroundColor !== getComputedStyle(document.querySelector('.monaco-editor .view-lines')).backgroundColor`), 'the tag has the guest\'s color');
    // The host's caret on the guest.
    await h.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 4, column: 3 }), true)`);
    await h.press('ArrowRight');
    await g.until(`[...document.querySelectorAll('.collab-tag')].some((t) => t.textContent === 'Hana') && !!document.querySelector('.monaco-editor .collab-caret')`, 'the guest sees Hana\'s caret and tag', 10000);
    const caretLine = await g.js(`(() => { const m = ide.editor.getModel(); const d = m.getAllDecorations().find((x) => x.options.beforeContentClassName?.includes('collab-caret')); return d && d.range.startLineNumber + ':' + d.range.startColumn; })()`);
    check(caretLine === '4:4', `the guest draws the host's caret where it is (${caretLine})`);
    // The caret moves with an edit made before it.
    await g.js(`(ide.editor.setPosition({ lineNumber: 4, column: 1 }), true)`);
    await g.type('ab');
    await g.until(`(() => { const m = ide.editor.getModel(); const d = m.getAllDecorations().find((x) => x.options.beforeContentClassName?.includes('collab-caret')); return d && d.range.startColumn === 6; })()`, 'the host\'s caret moves past the guest\'s typing', 5000);
    check(true, 'a caret moves with text typed before it');
  });

  await section('the guest follows the host', async () => {
    await pressNode(g, `document.querySelector('.collab-person[data-id="0"] .collab-follow')`, 'Follow Hana');
    await h.js(`ide.openFile(${S(hp('long.py'))})`);
    await g.until(`ide.activeTab()?.path === ide.collab.localPath('long.py')`, 'the guest follows into long.py', 15000);
    await g.until(`(ide.activeTab().model.getValue().includes('line_300'))`, 'long.py arrives');
    await h.js(`(ide.editor.setScrollTop(ide.editor.getTopForLineNumber(200)), true)`);
    await g.until(`Math.abs((ide.editor.getVisibleRanges()[0]?.startLineNumber || 0) - 200) <= 1`, 'the guest scrolls with the host', 10000);
    check(true, 'following opens the host\'s file and scrolls where the host looks');
    check(await g.js(`document.querySelector('.collab-person[data-id="0"] .collab-follow').textContent === 'Stop Following'`), 'the button says Stop Following');
    await pressNode(g, `document.querySelector('.collab-person[data-id="0"] .collab-follow')`, 'Stop Following');
    await h.js(`ide.openFile(${S(hp('shared.py'))})`);
    await sleep(1200);
    check(await g.js(`ide.activeTab()?.path === ide.collab.localPath('long.py')`), 'after Stop Following the guest stays where it is');
  });

  await section('the host makes the guest view only again', async () => {
    await pressNode(h, `document.querySelector('.collab-person[data-id="1"] .collab-role')`, 'Make View Only');
    await g.until(`!ide.collab.canEdit() && ide.editor.getOption(ide.monaco.editor.EditorOption.readOnly)`, 'the guest is view only', 10000);
    const before = await h.js(hostText('shared.py'));
    await g.js(`ide.openFile(ide.collab.localPath('shared.py'))`);
    await g.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 1, column: 1 }), true)`);
    await g.type('NOPE');
    await sleep(800);
    check(await h.js(hostText('shared.py')) === before && !(await g.js(guestText('shared.py'))).includes('NOPE'), 'a view-only guest\'s typing changes nothing anywhere');
  });

  await section('the host removes the guest', async () => {
    await pressNode(h, `document.querySelector('.collab-person[data-id="1"] .collab-kick')`, 'Remove');
    await pressButton(h, 'Remove from Session');
    await g.until(`ide.collab.state().role === null`, 'the guest is out', 15000);
    check(await g.js(`ide.notifications.list().some((n) => n.text === 'The host removed you from the session.')`), 'the guest is told it was removed');
    check(await g.js(`!ide.tabs.some((t) => t.path.startsWith('collab://')) && !ide.monaco.editor.getModels().some((m) => m.uri.scheme === 'collab')`), 'the guest\'s copy is gone');
    check(await h.js(`ide.collab.state().people.length === 1`), 'the host\'s list has only the host');
  });
} catch (err) {
  check(false, `collab-edit: ${err.message.split('\n')[0]}`);
}
pair.finish();
