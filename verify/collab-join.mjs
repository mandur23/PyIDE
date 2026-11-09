// Collaboration step 1 (docs/collab-coding-plan.md): the host starts a session from Tools (a join code through the
// tunnel, on the clipboard), a guest with no project open joins from the welcome screen (in Korean), the host accepts
// the request, and the guest sees the host's files read-only: the tree without hidden files, a file's text, typing that
// changes nothing, hidden and escaping paths refused. Leaving wipes the guest's copy; a declined request says so. Two
// app instances on loopback through a stand-in bore. Ports 9455 (host), 9456 (guest).
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { collabPair, sleep } from './collab-lib.mjs';

const MARKER = 'marker-collab-7f3a9c';
const pair = await collabPair({ name: 'collab-join', ports: [9455, 9456], guest: { lang: 'ko-KR' } });
const { h, g, check, section, pressButton, pressNode } = pair;
const S = JSON.stringify;
const hp = (n) => path.join(h.project, n);
const guestRows = `[...document.querySelectorAll('.collab-tree-row')].map((r) => r.dataset.rel)`;

try {
  writeFileSync(hp('hello.py'), `print('hello')\r\n# ${MARKER}\r\nvalue = 1\r\n`);
  writeFileSync(hp('.env'), 'TOKEN=secret-env-value\n');
  writeFileSync(hp('server.key'), 'KEY\n');
  mkdirSync(hp('.git'), { recursive: true });
  writeFileSync(hp(path.join('.git', 'config')), '[core]\n');
  writeFileSync(path.join(h.project, '..', 'outside.txt'), 'outside the project\n');
  await h.js(`ide.openFile(${S(hp('broken.py'))})`);
  await h.until(`ide.activeTab()?.path.endsWith('broken.py')`, 'host shows broken.py');

  let code = '';
  await section('the host starts a session', async () => {
    code = await pair.start({ name: 'Hana' });
    check(/^nanostudio:collab\?addr=127\.0\.0\.1:\d+&key=[A-Za-z0-9_-]{43}&name=Hana$/.test(code), 'the join code names the tunnel\'s address, a key and the host');
    check(code.endsWith(`:${pair.borePort()}&key=${code.split('key=')[1].split('&')[0]}&name=Hana`) || code.includes(`:${pair.borePort()}&`), 'the address is the tunnel\'s public port');
    check(await h.js(`window.__collabCopied === ide.collab.state().code`), 'the code is put on the clipboard');
    check(/local \d+ --local-host 127\.0\.0\.1 --to bore\.pub/.test(pair.boreArgs()), 'the tunnel is a bore client for the local listener (sent to the stand-in, not bore.pub)');
    check(await h.js(`!document.querySelector('#collabStatus').classList.contains('hidden') && document.querySelector('#collabStatus').textContent.includes('1 people')`), 'the status bar shows the session');
    check(await h.js(`ide.toolWindows.get('Collaboration').isVisible() && document.querySelector('.collab-session').textContent.includes('Sharing')`), 'the Collaboration tool window shows the session');
  });

  await section('a guest joins from the welcome screen', async () => {
    await g.js(`ide.closeProject()`);
    await g.until(`document.body.classList.contains('no-project') && !!document.querySelector('#welcomeCollab')`, 'the guest on the welcome screen');
    check(await g.js(`document.querySelector('#welcomeCollab').textContent === '세션 참여'`), 'the welcome screen offers Join Session in Korean');
    await g.click('#welcomeCollab');
    await g.until(`[...document.querySelectorAll('#dialogHost .dialog-title')].some((n) => n.textContent === '협업 세션 참여')`, 'the Korean join dialog');
    await pair.fill(g, '.collab-form .collab-code', `here it is: ${code}.`);
    await pair.fill(g, '.collab-form .collab-name', 'Min');
    await pressButton(g, '참여', { primary: true });
    await g.until(`document.querySelector('.collab-form .collab-status')?.textContent.includes('수락을 기다리는 중')`, 'the guest waits for the host (in Korean)', 20000);
    await h.until(`[...document.querySelectorAll('#dialogHost .dialog-message')].some((n) => n.textContent.includes('Min wants to join'))`, 'the host is asked', 20000);
    check(await h.js(`document.querySelector('#collabStatus').textContent.includes('1 waiting')`), 'the status bar says someone is waiting');
    check(await h.js(`[...document.querySelectorAll('.collab-request')].some((r) => r.textContent.includes('Min'))`), 'the request is listed in the tool window');
    await pressButton(h, 'Accept (View Only)');
    await g.until(`ide.collab.state().info?.you > 0 && !document.querySelector('#dialogHost .collab-form')`, 'the guest is in', 20000);
    check(await g.js(`document.body.classList.contains('collab-guest') && ide.toolWindows.get('Collaboration').isVisible()`), 'the guest\'s window shows the Collaboration tool window without a project of its own');
    check(await h.js(`ide.collab.state().people.map((p) => p.name + ':' + p.role).join() === 'Hana:host,Min:read'`), 'the host lists the guest, view only');
    check(await g.js(`[...document.querySelectorAll('.collab-person')].map((r) => r.textContent).join('|').includes('Min(나)')`), 'the guest sees itself in the list');
  });

  await section('the guest sees the host\'s files, not the hidden ones', async () => {
    await g.until(`${guestRows}.includes('hello.py')`, 'the host\'s tree on the guest', 15000);
    const rows = await g.js(guestRows);
    check(rows.includes('pkg') && rows.includes('broken.py') && rows.includes('hello.py'), `the tree lists the project (${rows.join(', ')})`);
    check(!rows.some((r) => ['.env', 'server.key', '.git'].includes(r)), 'hidden files (.env, *.key, .git/) are not listed');
    const pt = await g.js(`(() => { const r = [...document.querySelectorAll('.collab-tree-row')].find((x) => x.dataset.rel === 'pkg').getBoundingClientRect(); return { x: r.x + 30, y: r.y + r.height / 2 }; })()`);
    check(await g.js(`document.elementFromPoint(${pt.x}, ${pt.y})?.closest('.collab-tree-row')?.dataset.rel === 'pkg'`), 'a tree row is on screen where it is drawn');
    await pressNode(g, `[...document.querySelectorAll('.collab-tree-row')].find((x) => x.dataset.rel === 'pkg')`, 'the pkg folder');
    await g.until(`${guestRows}.some((r) => r.startsWith('pkg/'))`, 'pkg expands');
  });

  await section('the guest opens a file, read-only', async () => {
    await pressNode(g, `[...document.querySelectorAll('.collab-tree-row')].find((x) => x.dataset.rel === 'hello.py')`, 'hello.py');
    await g.until(`ide.activeTab()?.path.startsWith('collab://') && ide.activeTab().model.getValue().includes(${S(MARKER)})`, 'the guest shows hello.py', 15000);
    const shown = await g.js(`ide.activeTab().model.getValue()`);
    check(shown.replace(/\r\n/g, '\n') === readFileSync(hp('hello.py'), 'utf8').replace(/\r\n/g, '\n'), 'the guest\'s text is the host\'s file');
    check(await g.js(`ide.activeTab().model.getEOL() === '\\r\\n' && ide.activeTab().model.uri.scheme === 'collab'`), 'it keeps the file\'s CRLF and is no file of the guest\'s');
    check(await g.js(`ide.editor.getOption(ide.monaco.editor.EditorOption.readOnly) === true`), 'the guest\'s editor is read-only');
    check(await h.js(`!!ide.findTab(${S(hp('hello.py'))}) && ide.activeTab().path.endsWith('broken.py')`), 'the host holds the file in a background tab; its own tab stays in front');
    await g.js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 1, column: 1 }), true)`);
    await g.type('XYZ');
    await g.press('Enter');
    await sleep(800);
    check(!(await g.js(`ide.activeTab().model.getValue()`)).includes('XYZ'), 'typing in the guest changes nothing');
    check(!(await h.js(`ide.getDocument(${S(hp('hello.py'))}).model.getValue()`)).includes('XYZ') && !readFileSync(hp('hello.py'), 'utf8').includes('XYZ'), 'and nothing on the host');
  });

  await section('hidden and escaping paths are refused', async () => {
    for (const [rel, label] of [['.env', 'a hidden file'], ['../outside.txt', 'a path out of the project'], ['ENV~1', 'an 8.3 name'], ['hello.py:stream', 'a stream']]) {
      await g.js(`ide.openFile(ide.collab.localPath(${S(rel)}))`);
      await g.until(`!ide.tabs.some((t) => t.path === ide.collab.localPath(${S(rel)}))`, `the tab of ${rel} closes`, 15000);
      check(!(await g.js(`ide.monaco.editor.getModels().some((m) => m.getValue().includes('secret-env-value') || m.getValue().includes('outside the project'))`)), `${label} is refused, its text never reaches the guest`);
    }
    check(await g.js(`ide.notifications.list().some((n) => n.title.includes('.env') && n.text === '호스트가 공유하지 않는 파일입니다.')`), 'the guest is told the host does not share it (in Korean)');
  });

  await section('leaving wipes the guest\'s copy', async () => {
    await pressNode(g, `document.querySelector('.collab-stop')`, 'Leave');
    await g.until(`ide.collab.state().role === null`, 'the guest left', 15000);
    await h.until(`ide.collab.state().people.length === 1`, 'the host sees the guest go', 15000);
    check(await g.js(`!ide.tabs.some((t) => t.path.startsWith('collab://')) && !ide.monaco.editor.getModels().some((m) => m.uri.scheme === 'collab')`), 'no tab or text of the host\'s files is left on the guest');
    check(await g.js(`document.querySelector('#collabStatus').classList.contains('hidden') && !document.body.classList.contains('collab-guest')`), 'the guest\'s window is back to itself');
    await sleep(1500);
    const leaked = pair.filesHolding(path.dirname(g.userData), MARKER).concat(pair.filesHolding(g.project, MARKER));
    check(!leaked.length, `nothing of the host's files was written on the guest${leaked.length ? `: ${leaked.join(', ')}` : ''}`);
  });

  await section('a declined request says so', async () => {
    await pair.join(code, { name: 'Min', answer: 'Decline' });
    await g.until(`document.querySelector('.collab-form .collab-error:not(.hidden) .collab-notice-text')?.textContent === '호스트가 참여 요청을 거절했습니다.'`, 'the guest is told it was declined', 15000);
    check(true, 'a declined guest is told so in its dialog');
    check(await h.js(`ide.collab.state().people.length === 1 && !ide.collab.state().pending.length`), 'the host has no one waiting');
    await g.press('Escape');
  });

  await section('a damaged code is refused at once', async () => {
    await g.js(`(ide.runAction('Collab.Join'), true)`);
    await pair.fill(g, '.collab-form .collab-code', code.replace(/key=[^&]+/, 'key=short'));
    await pressButton(g, 'Join', { primary: true });
    await g.until(`document.querySelector('.collab-form .collab-error:not(.hidden)')?.textContent.includes('nanostudio:collab?')`, 'the damaged code is refused');
    check(true, 'a code with a damaged key is refused with what to do');
    await g.press('Escape');
  });

  await section('ending the session', async () => {
    await pressNode(h, `document.querySelector('.collab-stop')`, 'End Session');
    await pressButton(h, 'End Session');
    await h.until(`ide.collab.state().role === null && document.querySelector('#collabStatus').classList.contains('hidden')`, 'the session ended');
    check(true, 'the host ends the session');
  });
} catch (err) {
  check(false, `collab-join: ${err.message.split('\n')[0]}`);
}
pair.finish();
