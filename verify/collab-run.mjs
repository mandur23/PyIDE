// Collaboration step 5 (docs/collab-coding-plan.md): what runs on the host. A guest asks with Shift+F10 to run the
// file in front; the host's dialog says who asks, what runs and where, and nothing runs until the host presses Run
// Once (declining, a second request meanwhile, a path out of the project: nothing runs). The host shares a terminal:
// the guest watches it, its typing is dropped until the host allows it, then reaches the shell. The host opens a port
// of a web server to the guests, who reach it on their own localhost until the host closes it. Two app instances on
// loopback through a stand-in bore. Ports 9467 (host), 9468 (guest).
import { existsSync, readFileSync, writeFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { collabPair, sleep } from './collab-lib.mjs';

const pair = await collabPair({ name: 'collab-run', ports: [9467, 9468] });
const { h, g, check, section, pressButton, pressNode } = pair;
const S = JSON.stringify;
const hp = (n) => path.join(h.project, n);
const row = (rel) => `[...document.querySelectorAll('.collab-tree-row')].find((x) => x.dataset.rel === ${S(rel)})`;
const dialogShown = (title) => `[...document.querySelectorAll('#dialogHost .dialog-title')].some((n) => n.textContent === ${S(title)})`;
const ranMark = hp('ran.txt');
const web = http.createServer((req, res) => { res.end(`hello from the host's server ${req.url}`); });
await new Promise((r) => { web.listen(0, '127.0.0.1', r); });
const webPort = web.address().port;
const get = (port) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/page', timeout: 5000 }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b)); });
  req.on('error', () => resolve(null));
  req.on('timeout', () => { req.destroy(); resolve(null); });
});

try {
  writeFileSync(hp('run_me.py'), `from pathlib import Path\nPath(${S(ranMark)}).write_text('ran')\nprint('RAN OK')\n`);
  const code = await pair.start({ name: 'Hana' });
  await pair.join(code, { name: 'Min', answer: 'Accept (View Only)' });
  await g.until(`!!${row('run_me.py')}`, 'the guest\'s tree');
  await pressNode(g, row('run_me.py'), 'run_me.py');
  await g.until(`ide.activeTab()?.model.getValue().includes('RAN OK')`, 'the guest shows run_me.py', 15000);

  await section('a run request that the host declines runs nothing', async () => {
    await g.js(`(ide.editor.focus(), true)`);
    await g.press('Shift+F10');
    await h.until(dialogShown('Run Request'), 'the host is asked', 15000);
    const text = await h.js(`[...document.querySelectorAll('#dialogHost .dialog')].pop().textContent`);
    check(text.includes('Min asks to run run_me.py') && text.includes('run_me.py') && text.includes(h.project), 'the dialog says who asks, which file runs and where');
    check(await h.js(`[...document.querySelectorAll('#dialogHost .dialog-buttons .primary')].pop().textContent === 'Decline'`), 'Decline is the default button (Enter does not run it)');
    await sleep(2500);
    check(!existsSync(ranMark), 'nothing runs while the host has not answered');
    await g.js(`(ide.runAction('Collab.RequestRun'), true)`);
    await g.until(`ide.notifications.list().some((n) => n.text === 'You already asked: wait for the host\\'s answer.')`, 'a second request is refused', 10000);
    check(true, 'a second request while one waits is refused');
    await pressButton(h, 'Decline');
    await g.until(`ide.notifications.list().some((n) => n.text === 'The host declined to run it.')`, 'the guest hears it was declined', 15000);
    await sleep(2000);
    check(!existsSync(ranMark) && !(await h.js(`[...document.querySelectorAll('.run-tab')].some((t) => t.textContent.includes('run_me'))`)), 'declined: nothing ran and no run started');
  });

  await section('paths a run request cannot name', async () => {
    writeFileSync(path.join(h.project, '..', 'outside.py'), `open(${S(ranMark)}, 'w').write('outside')\n`);
    writeFileSync(hp('.env'), 'X=1\n');
    for (const rel of ['../outside.py', '.env', 'C:/Windows/notepad.exe']) {
      const r = await g.js(`ide.api.invoke('collab:runRequest', ${S(rel)})`);
      check(!r.ok && ['badPath', 'hidden'].includes(r.code), `a request for ${rel} is refused (${r.code})`);
    }
    await sleep(1000);
    check(!(await h.js(dialogShown('Run Request'))) && !existsSync(ranMark), 'the host is not even asked, and nothing runs');
  });

  await section('a run the host allows', async () => {
    await g.js(`(ide.editor.focus(), true)`);
    await g.press('Shift+F10');
    await h.until(dialogShown('Run Request'), 'the host is asked again', 15000);
    await pressButton(h, 'Run Once');
    for (let i = 0; i < 100 && !existsSync(ranMark); i++) await sleep(300);
    check(existsSync(ranMark) && readFileSync(ranMark, 'utf8') === 'ran', 'Run Once runs the file on the host');
    await g.until(`document.querySelector('.collab-output .console')?.textContent.includes('RAN OK')`, 'the guest reads the output', 30000);
    check(true, 'the guest reads the run\'s output');
    check(await g.js(`ide.notifications.list().some((n) => n.text === 'The host allowed your request.')`), 'the guest is told the host allowed it');
  });

  await section('the shared terminal', async () => {
    await pressNode(h, `document.querySelector('.collab-share-terminal')`, 'Share Terminal');
    await h.until(`document.querySelector('.collab-share-terminal')?.textContent === 'Stop Sharing Terminal'`, 'the terminal is shared', 30000);
    await g.until(`ide.toolWindows.get('CollabTerminal').isVisible() && !!document.querySelector('.collab-term-box .xterm')`, 'the guest sees the host\'s terminal', 20000);
    await h.js(`(ide.api.send('pty:write', { id: ide.terminal.active().id, data: 'echo HOST_SAYS_HI\\r' }), true)`);
    await g.until(`document.querySelector('.collab-term-box')?.textContent.includes('HOST_SAYS_HI')`, 'the guest sees the host\'s command', 20000);
    check(true, 'the guest watches what happens in the host\'s terminal');
    // Typing before the host allows it is dropped.
    await g.click('.collab-term-box .xterm');
    await g.type('echo pwned>typed-early.txt');
    await g.press('Enter');
    await g.js(`(ide.api.send('collab:termInput', 'echo pwned>typed-early.txt\\r'), true)`);
    await sleep(2500);
    check(!existsSync(hp('typed-early.txt')), 'what the guest types before the host allows it never reaches the shell');
    await pressNode(g, `document.querySelector('.collab-term-bar button:not(.hidden)')`, 'Ask to Type');
    await h.until(dialogShown('Typing in Your Terminal'), 'the host is asked about typing', 15000);
    await pressButton(h, 'Allow Typing');
    await g.until(`document.querySelector('.collab-term-note').textContent.includes('you may type')`, 'the guest may type', 10000);
    await g.click('.collab-term-box .xterm');
    await g.type('echo typed>typed.txt');
    await g.press('Enter');
    for (let i = 0; i < 60 && !existsSync(hp('typed.txt')); i++) await sleep(250);
    check(existsSync(hp('typed.txt')), 'once allowed, the guest\'s typing reaches the host\'s shell');
    await pressNode(h, `document.querySelector('.collab-share-terminal')`, 'Stop Sharing Terminal');
    await g.until(`document.querySelector('.collab-term-note').textContent === 'The host shares no terminal.'`, 'the guest sees the sharing stop', 10000);
    await g.js(`(ide.api.send('collab:termInput', 'echo late>typed-late.txt\\r'), true)`);
    await sleep(2000);
    check(!existsSync(hp('typed-late.txt')), 'after the host stops sharing, nothing the guest sends reaches the shell');
  });

  await section('a port opened to guests', async () => {
    await pressNode(h, `document.querySelector('.collab-share-port')`, 'Open a Port…');
    await h.until(`!document.querySelector('#popup').classList.contains('hidden')`, 'the port prompt');
    await h.type(String(webPort));
    await h.press('Enter');
    await g.until(`!!document.querySelector('.collab-port[data-port="${webPort}"]')`, 'the guest lists the port', 15000);
    const local = Number((await g.js(`document.querySelector('.collab-port[data-port="${webPort}"] .collab-port-text').textContent`)).match(/localhost:(\d+)/)[1]);
    const body = await get(local);
    check(body === 'hello from the host\'s server /page', `the guest reaches the host's web server on its own localhost:${local}`);
    await pressNode(h, `[...document.querySelectorAll('.collab-port button')].find((b) => b.textContent === 'Close')`, 'Close the port');
    await g.until(`!document.querySelector('.collab-port[data-port="${webPort}"]')`, 'the guest drops the port', 15000);
    check((await get(local)) === null, 'once the host closes it, the guest\'s localhost reaches nothing');
  });
} catch (err) {
  check(false, `collab-run: ${err.message.split('\n')[0]}`);
}
web.close();
pair.finish();
