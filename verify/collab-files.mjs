// Collaboration step 3 (docs/collab-coding-plan.md): files. A guest the host lets edit saves with Ctrl+S (the host's
// window writes the file), makes, renames and deletes files from its tree's menu (the host does it on its disk, a
// deleted file to its Recycle Bin, here a stand-in folder), and sees a file the host made appear. Then the network
// goes dark (the stand-in bore drops every byte) while both keep typing: both notice, the guest reconnects once the
// network is back, and no edit is lost or doubled. When the host ends the session, nothing of its files is left on the
// guest. Two app instances on loopback through a stand-in bore. Ports 9463 (host), 9464 (guest).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { collabPair, sleep } from './collab-lib.mjs';
import { tempDir } from './lib.mjs';

const MARKER = 'marker-collab-files-51d2';
const trashDir = tempDir('collab-files-trash');
const pair = await collabPair({ name: 'collab-files', ports: [9463, 9464], host: { env: { PYIDE_COLLAB_TRASH: trashDir } } });
const { h, g, check, section, pressButton, pressNode } = pair;
const S = JSON.stringify;
const hp = (n) => path.join(h.project, n);
const hostText = (n) => `ide.getDocument(${S(hp(n))})?.model.getValue()`;
const guestText = (n) => `ide.getDocument(ide.collab.localPath(${S(n)}))?.model.getValue()`;
const lf = (s) => (s || '').replace(/\r\n/g, '\n');
const row = (rel) => `[...document.querySelectorAll('.collab-tree-row')].find((x) => x.dataset.rel === ${S(rel)})`;
// A right click on a node, then a menu item.
async function menu(ctx, target, item) {
  await ctx.until(`!!(${target})`, `the node for ${item}`);
  const p = await ctx.js(`(() => { const r = (${target}).getBoundingClientRect(); return { x: r.x + Math.min(40, r.width / 2), y: r.y + Math.min(r.height / 2, 30) }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await ctx.cdp('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'right', clickCount: 1 });
  await ctx.until(`[...document.querySelectorAll('.context-menu .menu-item')].some((r) => r.querySelector('.menu-label')?.textContent === ${S(item)})`, `menu item ${item}`);
  await pressNode(ctx, `[...document.querySelectorAll('.context-menu .menu-item')].find((r) => r.querySelector('.menu-label')?.textContent === ${S(item)})`, item);
}
async function promptAnswer(ctx, text) {
  await ctx.until(`!document.querySelector('#popup').classList.contains('hidden') && document.activeElement?.id === 'popupIn'`, 'the name prompt');
  await ctx.press('Ctrl+a');
  await ctx.type(text);
  await ctx.press('Enter');
}

try {
  writeFileSync(hp('shared.py'), `# ${MARKER}\nvalue = 1\n`);
  const code = await pair.start({ name: 'Hana' });
  await pair.join(code, { name: 'Min', answer: 'Accept and Allow Editing' });
  await g.until(`!!${row('shared.py')}`, 'the guest\'s tree');

  await section('a guest saves with Ctrl+S', async () => {
    await pressNode(g, row('shared.py'), 'shared.py');
    await g.until(`(${guestText('shared.py')} || '').includes('value = 1')`, 'the guest shows shared.py', 15000);
    await g.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 3, column: 1 }), true)`);
    await g.type('saved_by_guest = True');
    await h.until(`(${hostText('shared.py')} || '').includes('saved_by_guest')`, 'the host has the edit');
    check(!readFileSync(hp('shared.py'), 'utf8').includes('saved_by_guest'), 'the edit is not on disk before the save');
    check(await h.js(`ide.isDirty(ide.findTab(${S(hp('shared.py'))}))`), 'the host\'s tab shows the file modified');
    await g.press('Ctrl+s');
    await h.until(`!ide.isDirty(ide.findTab(${S(hp('shared.py'))}))`, 'the host saved', 15000);
    check(readFileSync(hp('shared.py'), 'utf8').includes('saved_by_guest = True'), 'the guest\'s Ctrl+S writes the file on the host');
  });

  await section('a guest makes, renames and deletes a file', async () => {
    await menu(g, `document.querySelector('.collab-tree')`, 'New File…');
    await promptAnswer(g, 'made.py');
    await g.until(`ide.activeTab()?.path === ide.collab.localPath('made.py')`, 'the new file opens on the guest', 15000);
    check(existsSync(hp('made.py')), 'New File makes the file on the host');
    await g.until(`!!${row('made.py')}`, 'the new file in the guest\'s tree');
    check(true, 'and the guest\'s tree shows it');
    await g.type('print("made")');
    await g.press('Ctrl+s');
    await sleep(1500);
    check(readFileSync(hp('made.py'), 'utf8').includes('print("made")'), 'the new file saves');

    await menu(g, row('made.py'), 'Rename…');
    await promptAnswer(g, 'renamed.py');
    await g.until(`ide.activeTab()?.path === ide.collab.localPath('renamed.py')`, 'the guest\'s tab follows the rename', 15000);
    check(existsSync(hp('renamed.py')) && !existsSync(hp('made.py')), 'Rename renames the file on the host');
    check(await g.js(`ide.activeTab().model.getValue().includes('print("made")')`), 'the renamed tab keeps its text');
    await g.until(`!!${row('renamed.py')} && !${row('made.py')}`, 'the guest\'s tree follows');
    check(await h.js(`!ide.findTab(${S(hp('made.py'))})`), 'the host has no tab of the old name');

    await menu(g, row('renamed.py'), 'Delete…');
    await pressButton(g, 'Delete');
    await g.until(`!ide.tabs.some((t) => t.path === ide.collab.localPath('renamed.py'))`, 'the deleted file\'s tab closes', 15000);
    check(!existsSync(hp('renamed.py')) && readdirSync(trashDir).some((n) => n.endsWith('renamed.py')), 'Delete moves the file to the host\'s Recycle Bin');
    await g.until(`!${row('renamed.py')}`, 'the deleted file leaves the guest\'s tree');
    check(true, 'and the guest\'s tree');

    await menu(g, `document.querySelector('.collab-tree')`, 'New File…');
    await promptAnswer(g, '.env');
    await sleep(1200);
    check(!existsSync(hp('.env')) && await g.js(`ide.notifications.list().some((n) => n.title.includes('.env') && n.text === 'The host does not share this file.')`), 'a hidden name is refused, with the reason');
  });

  await section('a file the host makes appears for the guest', async () => {
    mkdirSync(hp('docs'), { recursive: true });
    writeFileSync(hp('fromhost.py'), 'x = 1\n');
    await g.until(`!!${row('fromhost.py')} && !!${row('docs')}`, 'the host\'s new file in the guest\'s tree', 20000);
    check(true, 'files made on the host show up in the guest\'s tree by themselves');
  });

  await section('the network goes dark, and both keep typing', async () => {
    await pressNode(g, row('shared.py'), 'shared.py');
    await g.until(`ide.activeTab()?.path === ide.collab.localPath('shared.py')`, 'shared.py in front');
    await h.js(`ide.openFile(${S(hp('shared.py'))})`);
    await h.until(`ide.activeTab()?.path.endsWith('shared.py')`, 'the host shows shared.py');
    pair.bore.tap = () => null;
    await g.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 1, column: 1 }), true)`);
    for (let i = 0; i < 5; i++) await g.type(`G${i} `);
    await h.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 2, column: 1 }), true)`);
    for (let i = 0; i < 5; i++) await h.type(`H${i} `);
    await h.until(`ide.collab.state().people.find((p) => p.id === 1)?.state === 'away'`, 'the host sees the guest disconnected', 45000);
    check(await h.js(`document.querySelector('.collab-person[data-id="1"] .collab-person-role').textContent === 'Disconnected'`), 'the host\'s list shows the guest disconnected');
    await g.until(`ide.collab.state().state === 'reconnecting'`, 'the guest notices', 45000);
    check(await g.js(`document.querySelector('#collabStatus').textContent.includes('reconnecting')`), 'the guest\'s status bar says it is reconnecting');
    for (let i = 5; i < 8; i++) await g.type(`G${i} `);
    pair.bore.tap = null;
    await g.until(`ide.collab.state().state === 'online'`, 'the guest is back', 60000);
    const all = [...Array(8).keys()].map((i) => `G${i} `).concat([...Array(5).keys()].map((i) => `H${i} `));
    await h.until(`(() => { const t = ${hostText('shared.py')}; return ${S(all)}.every((w) => t.includes(w)); })()`, 'the host has every edit', 20000);
    await g.until(`(() => { const t = ${guestText('shared.py')}; return ${S(all)}.every((w) => t.includes(w)); })()`, 'the guest has every edit', 20000);
    await sleep(800);
    const [a, b] = [await h.js(hostText('shared.py')), await g.js(guestText('shared.py'))];
    check(lf(a) === lf(b), 'after the reconnect both have the same text');
    check(all.every((w) => a.split(w).length === 2), 'every edit made while offline is there exactly once');
    check(await g.js(`ide.notifications.list().some((n) => n.title === 'Connected to the host again')`), 'the guest is told it is connected again');
    check(await h.js(`ide.collab.state().people.find((p) => p.id === 1)?.state === 'online'`), 'the host lists the guest online again');
  });

  await section('the host ends the session: the guest keeps nothing', async () => {
    await pressNode(h, `document.querySelector('.collab-stop')`, 'End Session');
    await pressButton(h, 'End Session');
    try { await g.until(`ide.collab.state().role === null`, 'the guest is out', 15000); } catch (err) {
      console.log('host', S(await h.js(`({ role: ide.collab.state().role, dialogs: [...document.querySelectorAll('#dialogHost .dialog')].map((d) => d.textContent.slice(0, 120)) })`)));
      console.log('guest', S(await g.js(`({ s: ide.collab.state(), notes: ide.notifications.list().slice(-4).map((n) => n.title + ': ' + n.text) })`)));
      await h.shot('end-host.png'); await g.shot('end-guest.png');
      for (const [who, ctx] of [['host', h], ['guest', g]]) {
        const logs = pair.filesHolding(ctx.userData, '#collab');
        for (const f of logs) console.log(who, f, readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.includes('#collab')).slice(-25).join('\n'));
      }
      throw err;
    }
    check(await g.js(`ide.notifications.list().some((n) => n.text === 'The host ended the collaboration session.')`), 'the guest is told the host ended it');
    check(await g.js(`!ide.tabs.some((t) => t.path.startsWith('collab://')) && !ide.monaco.editor.getModels().some((m) => m.uri.scheme === 'collab')`), 'no tab or text of the host\'s files is left');
    check(await g.js(`!document.querySelector('.collab-tree-row')`), 'the host\'s tree is gone');
    await sleep(1500);
    const leaked = pair.filesHolding(path.dirname(g.userData), MARKER).concat(pair.filesHolding(g.project, MARKER));
    check(!leaked.length, `nothing of the host's files was written on the guest${leaked.length ? `: ${leaked.join(', ')}` : ''}`);
  });
} catch (err) {
  check(false, `collab-files: ${err.message.split('\n')[0]}`);
}
pair.finish();
