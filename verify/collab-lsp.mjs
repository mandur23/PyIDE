// Collaboration step 4 (docs/collab-coding-plan.md): the host's language server for the guest, the host's runs and
// chat. In the guest's copy of a Python file: completion (the same items the host's Pyright gives the host, and a
// real Ctrl+Space and Enter), hover documentation, Ctrl+B into another file, and the host's problems, which go away
// when the guest fixes the code. The host runs the file and the guest reads the output; both chat. Two app
// instances on loopback through a stand-in bore. Ports 9465 (host), 9466 (guest).
import { writeFileSync } from 'fs';
import path from 'path';
import { collabPair, sleep } from './collab-lib.mjs';

const pair = await collabPair({ name: 'collab-lsp', ports: [9465, 9466] });
const { h, g, check, section, pressNode } = pair;
const S = JSON.stringify;
const hp = (n) => path.join(h.project, n);
const row = (rel) => `[...document.querySelectorAll('.collab-tree-row')].find((x) => x.dataset.rel === ${S(rel)})`;
const guestModel = `ide.getDocument(ide.collab.localPath('main.py'))?.model`;

try {
  writeFileSync(hp('mod.py'), 'def compute_total(price, qty):\n    """Multiply price by qty."""\n    return price * qty\n');
  writeFileSync(hp('main.py'), 'from mod import compute_total\n\nresult = compute_total(2, 3)\nprint("total", result)\nundefined_name\n');
  await h.js(`ide.openFile(${S(hp('main.py'))})`);
  await h.until(`ide.lsp?.status() === 'ready'`, 'the host\'s Pyright is ready', 90000);
  const code = await pair.start({ name: 'Hana' });
  await pair.join(code, { name: 'Min', answer: 'Accept and Allow Editing' });
  await g.until(`!!${row('main.py')}`, 'the guest\'s tree');
  await pressNode(g, row('main.py'), 'main.py');
  await g.until(`(${guestModel}?.getValue() || '').includes('compute_total(2, 3)')`, 'the guest shows main.py', 15000);
  await g.until(`document.querySelector('#statusLineSeparator')?.textContent === 'LF'`, 'the status bar says LF', 5000).catch(() => {});
  check(await g.js(`document.querySelector('#statusLineSeparator')?.textContent === 'LF' && ide.getDocument(ide.collab.localPath('main.py')).lineSeparator.length === 1`), 'the guest\'s status bar shows the host file\'s LF');

  await section('problems from the host\'s Pyright', async () => {
    await g.until(`ide.monaco.editor.getModelMarkers({ resource: ${guestModel}.uri }).some((m) => m.owner === 'collab' && m.startLineNumber === 5 && m.message.includes('undefined_name'))`, 'the guest sees the problem', 45000);
    check(true, 'the guest\'s copy shows the host\'s problem on undefined_name');
    check(await g.js(`!!document.querySelector('.monaco-editor .squiggly-error, .monaco-editor .squiggly-warning')`), 'drawn as a squiggle');
    await g.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 5, column: 15 }), true)`);
    await g.type(' = 1');
    await g.until(`!ide.monaco.editor.getModelMarkers({ resource: ${guestModel}.uri }).some((m) => m.startLineNumber === 5 && m.message.includes('undefined_name'))`, 'the problem goes once fixed', 45000);
    check(true, 'fixing it on the guest clears the problem the host\'s Pyright reported');
  });

  await section('completion', async () => {
    await g.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 6, column: 1 }), true)`);
    await g.press('Enter');
    await g.type('x = compute_');
    await sleep(800);
    const pos = await g.js(`(() => { const p = ide.editor.getPosition(); return { line: p.lineNumber - 1, character: p.column - 1 }; })()`);
    await h.until(`(ide.getDocument(${S(hp('main.py'))}).model.getValue()).includes('x = compute_')`, 'the host has the guest\'s text');
    const hostLabels = await h.js(`(async () => { const d = ide.getDocument(${S(hp('main.py'))}); const r = await ide.lsp.clientFor(d.path).request('textDocument/completion', { textDocument: { uri: d.model.uri.toString() }, position: ${S(pos)}, context: { triggerKind: 1 } }); const items = Array.isArray(r) ? r : r?.items || []; return items.map((i) => i.label).slice(0, 300).sort(); })()`);
    const guestLabels = await g.js(`ide.api.invoke('collab:lsp', 'completion', 'main.py', ${S(pos)}).then((r) => (r.result || []).map((i) => i.label).sort())`);
    check(hostLabels.includes('compute_total') && S(hostLabels) === S(guestLabels), `the guest's completion is the host's (${guestLabels.length} items)`);
    await g.press('Ctrl+Space');
    await g.until(`[...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')].some((r) => r.textContent.includes('compute_total'))`, 'the suggestion list on the guest', 20000);
    check(true, 'Ctrl+Space shows compute_total in the guest\'s list');
    await g.press('Enter');
    try { await g.until(`${guestModel}.getLinesContent().some((l) => l.startsWith('x = compute_total'))`, 'Enter takes it'); } catch (err) {
      console.log('line7', S(await g.js(`${guestModel}.getValue()`)));
      throw err;
    }
    check(true, 'Enter completes the name');
  });

  await section('hover and Go to Declaration', async () => {
    await g.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 3, column: 12 }), true)`);
    await g.press('Ctrl+q');
    await g.until(`[...document.querySelectorAll('.monaco-hover')].some((n) => n.textContent.includes('Multiply price by qty'))`, 'the hover with the docstring', 20000);
    check(true, 'Ctrl+Q shows the host\'s documentation of compute_total');
    await g.press('Escape');
    await g.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 3, column: 12 }), true)`);
    await g.press('Ctrl+b');
    await g.until(`ide.activeTab()?.path === ide.collab.localPath('mod.py') && ide.editor.getPosition().lineNumber === 1`, 'Ctrl+B opens mod.py at the def', 20000);
    check(await g.js(`ide.activeTab().model.getValue().includes('Multiply price by qty')`), 'Ctrl+B goes to the declaration in the host\'s mod.py');
  });

  await section('the host\'s run output', async () => {
    await h.js(`ide.openFile(${S(hp('main.py'))})`);
    await h.js(`(ide.saveAll(), true)`);
    await h.js(`(ide.run.runCurrentFile(), true)`);
    await g.until(`document.querySelector('.collab-output .console')?.textContent.includes('total 6')`, 'the guest reads the host\'s output', 60000);
    check(true, 'the guest reads what the host\'s run prints');
    check(await g.js(`ide.toolWindows.get('CollabOutput').isVisible() && document.querySelector('.collab-output .console').textContent.includes('Hana runs main')`), 'in the Host Output tool window, which opens and says whose run it is');
  });

  await section('chat', async () => {
    await g.js(`ide.toolWindows.get('Collaboration').show()`);
    await g.click('.collab-chat-input');
    await g.type('hello host');
    await g.press('Enter');
    await h.until(`[...document.querySelectorAll('.collab-chat-row')].some((r) => r.textContent === 'Min: hello host')`, 'the host reads the guest', 15000);
    check(true, 'the guest\'s message reaches the host');
    await h.js(`ide.toolWindows.get('Collaboration').show()`);
    await h.click('.collab-chat-input');
    await h.type('안녕하세요 <b>x</b>');
    await h.press('Enter');
    await g.until(`[...document.querySelectorAll('.collab-chat-row')].some((r) => r.textContent === 'Hana: 안녕하세요 <b>x</b>')`, 'the guest reads the host', 15000);
    check(await g.js(`!document.querySelector('.collab-chat-row b')`), 'a message is shown as text, never as markup');
  });
} catch (err) {
  check(false, `collab-lsp: ${err.message.split('\n')[0]}`);
}
pair.finish();
