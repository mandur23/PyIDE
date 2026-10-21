// Split terminals (PyCharm's Split Right / Split Down): nested panes, each its own PTY in its own folder, output that
// stays in its pane, divider resizing reaching the PTY, closing and `exit`, focus actions, shortcut labels, and no
// shell left running after a pane, a tab, the project or the app closes. Ports 9210-9211.
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { launch } from './lib.mjs';
import { missingTranslations } from './i18n-lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// pid -> [pid and all its descendants], from one process snapshot.
function withDescendants(pids) {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }'], { encoding: 'utf8' });
  const children = new Map();
  const names = new Map();
  for (const line of out.split(/\r?\n/)) {
    const [pid, ppid, ...name] = line.trim().split(' ');
    if (!pid) continue;
    names.set(Number(pid), name.join(' '));
    (children.get(Number(ppid)) || children.set(Number(ppid), []).get(Number(ppid))).push(Number(pid));
  }
  const all = [];
  const walk = (p) => { if (all.some((x) => x.pid === p)) return; all.push({ pid: p, name: names.get(p) }); for (const c of children.get(p) || []) walk(c); };
  for (const p of pids) walk(p);
  return all.filter((x) => x.name);
}
async function gone(procs, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!procs.some((p) => alive(p.pid))) return true;
    await sleep(250);
  }
  return false;
}
const names = (procs) => procs.map((p) => `${p.name}:${p.pid}`).join(', ');
// The shells and what they run (not helpers such as conhost) are all still alive.
const procsAlive = (procs) => procs.length > 0 && procs.filter((p) => /powershell|pwsh|ping/i.test(p.name)).every((p) => alive(p.pid));

const t = await launch({ fixture: 'core', port: 9210, name: 'terminal-split' });
const { js, until, press, type, check, shot, cdp } = t;
const send = (id, text) => js(`ide.terminal.send(${JSON.stringify(text)}, ${id})`);
const text = (id) => js(`ide.terminal.text(${id})`);
const prompt = (id, re = 'PS .*>') => until(`/${re}\\s*$/.test(ide.terminal.text(${id}).trimEnd())`, `prompt in pane ${id}`, 30000);
const layout = () => js(`ide.terminal.tabs()[${0}]?.layout`);
const activeId = () => js('ide.terminal.active()?.id');
const focusedPane = () => js(`Number(document.activeElement?.closest('.term-pane')?.dataset.session)`);
// Runs a PowerShell expression in a pane and returns its value; the marker is split in the command so the echoed
// command line never matches.
let seq = 0;
async function ask(id, expr) {
  const tag = `ANS${++seq}`;
  await send(id, `Write-Output ("${tag.slice(0, 2)}" + "${tag.slice(2)}=" + (${expr}))\r`);
  await until(`new RegExp('(^|\\\\n)${tag}=').test(ide.terminal.text(${id}))`, `${tag} in pane ${id}`, 15000);
  return (await text(id)).match(new RegExp(`(?:^|\\n)${tag}=(.*)`))[1].trim();
}
async function mouse(x, y, button = 'left', clickCount = 1) {
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x, y, button, clickCount });
  await sleep(80);
}
const centerOf = (sel) => js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`);
async function menuPick(label) {
  await until(`!!document.querySelector('.context-menu')`, 'context menu');
  const items = await js(`[...document.querySelectorAll('.context-menu .menu-item')].map(n => n.firstChild.textContent)`);
  await js(`[...document.querySelectorAll('.context-menu .menu-item')].find(n => n.firstChild.textContent === ${JSON.stringify(label)}).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  return items;
}

// A new tab from the tool window's + button (showing the window with no session would start one of its own).
async function newTab() {
  const n = await js('ide.terminal.tabs().length');
  await js(`(document.querySelector('.term-tabs .term-new').click(), true)`);
  await until(`ide.terminal.tabs().length === ${n + 1} && ide.terminal.active()?.pid`, 'new tab');
}

let finished = false;
try {
  // ---------- one pane, in a folder the shell reports ----------
  await press('Alt+F12');
  await until(`ide.terminal.sessions().length === 1 && ide.terminal.sessions()[0].id`, 'first session');
  const A = await activeId();
  await prompt(A, 'PS .*project>');
  // PowerShell does not report its folder by itself; Windows Terminal's OSC 9;9 is what a prompt hook would print.
  await send(A, 'New-Item -ItemType Directory splitdir | Out-Null; cd splitdir; [Console]::Write("$([char]27)]9;9;`"$PWD`"$([char]7)")\r');
  await until(`/splitdir$/.test(ide.terminal.sessions()[0].cwd)`, 'cwd reported by the shell');
  check(true, 'a pane follows the folder its shell reports (OSC 9;9)');

  // Any program can print these: a UNC path (\\host\share, an SMB connection and NTLM leak when the split checks
  // it) or an OSC 7 URL naming another host is ignored; only a local drive path from no host, localhost or this
  // computer is taken.
  const osc = (body) => `[Console]::Write([string][char]27 + ${body} + [char]7)`;
  let mk = 0;
  const flush = async (id) => {
    const tag = `OSC${++mk}`;
    await send(id, `Write-Output ("${tag.slice(0, 3)}" + "${tag.slice(3)}=done")\r`);
    await until(`new RegExp('(^|\\\\n)${tag}=done').test(ide.terminal.text(${id}))`, `${tag} in pane ${id}`, 15000);
  };
  const cwdOf = (id) => js(`ide.terminal.sessions().find(s => s.id === ${id}).cwd`);
  const splitCwd = await cwdOf(A);
  await send(A, `${osc(`']9;9;"\\\\evil-host\\share"'`)}; ${osc(`']7;file://evil-host/C:/Windows'`)}; ${osc(`']7;file:////evil-host/share/x'`)}; ${osc(`']9;9;\\\\?\\UNC\\evil-host\\share'`)}\r`);
  await flush(A);
  check((await cwdOf(A)) === splitCwd, `UNC paths and other hosts from OSC 9;9 / OSC 7 are ignored (${await cwdOf(A)})`);
  await send(A, `${osc(`']7;file://localhost/C:/Windows'`)}\r`);
  await flush(A);
  const viaLocalhost = await cwdOf(A);
  await send(A, `${osc(`']7;file://' + [System.Net.Dns]::GetHostName() + '/C:/Users'`)}\r`);
  await flush(A);
  const viaHostname = await cwdOf(A);
  check(viaLocalhost === 'C:\\Windows' && viaHostname === 'C:\\Users', `OSC 7 from localhost or this computer is taken (${viaLocalhost}, ${viaHostname})`);
  await send(A, '[Console]::Write("$([char]27)]9;9;`"$PWD`"$([char]7)")\r');
  await until(`/splitdir$/.test(ide.terminal.sessions()[0].cwd)`, 'cwd back to splitdir');

  // Main refuses a UNC folder itself, before any file system call: the session starts in the home folder.
  const unc = '\\\\127.0.0.1\\C$\\Windows';
  await js(`(window.__uncOut = {}, ide.api.on('pty:data', ({ id, data }) => { window.__uncOut[id] = (window.__uncOut[id] || '') + data; }), true)`);
  const uncId = await js(`ide.api.invoke('pty:create', { shell: 'powershell', cwd: ${JSON.stringify(unc)}, cols: 120, rows: 24, command: 'Write-Output ("UNC" + "CWD=" + $PWD.Path)' }).then(r => r.id)`);
  await until(`/UNCCWD=[^\\r\\n]*[\\r\\n]/.test((window.__uncOut[${uncId}] || '').replace(/\\x1b\\[[0-9;?]*[A-Za-z]/g, ''))`, 'UNC session reports its folder', 20000);
  const uncRaw = (await js(`window.__uncOut[${uncId}]`)).replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const uncCwd = uncRaw.match(/UNCCWD=([^\r\n]*)/)[1].trim();
  await js(`ide.api.invoke('pty:kill', ${uncId}).then(() => true)`);
  check(/^[A-Za-z]:\\/.test(uncCwd) && !/\\Windows$/i.test(uncCwd), `pty:create starts a session asked for a UNC folder in the home folder (${uncCwd})`);

  // ---------- Split Right from the toolbar ----------
  await t.click('#bottomActions [data-action="terminal-split-right"]');
  await until(`ide.terminal.sessions().length === 2 && ide.terminal.sessions()[1].id`, 'second pane');
  const B = await activeId();
  await prompt(B, 'PS .*splitdir>');
  let l = await layout();
  check(l?.dir === 'row' && l.a.id === A && l.b.id === B && (await js('ide.terminal.tabs().length')) === 1,
    `Split Right puts a new pane to the right in the same tab (${JSON.stringify(l)})`);
  check(B !== A && (await js(`ide.terminal.sessions()[1].pid !== ide.terminal.sessions()[0].pid`)), 'the new pane is its own PTY session');
  check(true, 'the new pane starts in the active pane\'s folder');
  check((await focusedPane()) === B && (await js(`document.querySelector('.term-layout.split-mode .term-pane.active')?.dataset.session`)) === String(B),
    'the new pane has the keyboard and the focus outline');
  const outline = await js(`getComputedStyle(document.querySelector('.term-pane.active'), '::after').borderTopWidth`);
  check(parseFloat(outline) > 0, `the active pane draws an outline (${outline})`);

  // ---------- Split Down from the pane's context menu (nested) ----------
  const bBox = await centerOf(`.term-pane[data-session="${B}"] .xterm-screen`);
  await mouse(bBox.x, bBox.y, 'right');
  const paneMenu = await menuPick('Split Down');
  check(paneMenu.includes('Split Right') && paneMenu.includes('Close Session'), `pane menu has Split Right, Split Down and Close Session (${paneMenu.join(', ')})`);
  await until(`ide.terminal.sessions().length === 3 && ide.terminal.sessions()[2].id`, 'third pane');
  const C = await activeId();
  await prompt(C, 'PS .*splitdir>');
  l = await layout();
  check(l.dir === 'row' && l.a.id === A && l.b.dir === 'column' && l.b.a.id === B && l.b.b.id === C,
    `Split Down nests a pane below the right one (${JSON.stringify(l)})`);
  const geo = await js(`[${A}, ${B}, ${C}].map(id => document.querySelector('.term-pane[data-session="' + id + '"]').getBoundingClientRect()).map(r => ({ x: r.x, y: r.y, w: r.width, h: r.height }))`);
  check(geo[1].x > geo[0].x + 50 && Math.abs(geo[1].x - geo[2].x) < 2 && geo[2].y > geo[1].y + 20, `panes are laid out right and below (${JSON.stringify(geo)})`);

  // ---------- output stays in its pane ----------
  for (const [id, m] of [[A, 'A'], [B, 'B'], [C, 'C']]) await send(id, `Write-Output ("MARK" + "_${m}_" + $PID)\r`);
  const own = {};
  for (const [id, m] of [[A, 'A'], [B, 'B'], [C, 'C']]) {
    await until(`/(^|\\n)MARK_${m}_\\d+/.test(ide.terminal.text(${id}))`, `marker ${m}`);
    own[m] = (await text(id)).match(/(?:^|\n)MARK_[ABC]_\d+/g).map((s) => s.trim());
  }
  const pids = await js(`ide.terminal.sessions().map(s => s.pid)`);
  check(own.A.join() === `MARK_A_${pids[0]}` && own.B.join() === `MARK_B_${pids[1]}` && own.C.join() === `MARK_C_${pids[2]}`,
    `each pane runs its own shell and shows only its own output (${JSON.stringify(own)})`);
  check((await js(`ide.terminal.tabs()[0].name`)) === (await js(`ide.terminal.active().name`)), 'the tab title follows the active pane');

  // ---------- divider: PTY size follows, with a minimum ----------
  const colsBefore = Number(await ask(A, '$Host.UI.RawUI.WindowSize.Width'));
  const xtermBefore = (await layout()).a.cols;
  const handle = await centerOf('.term-layout:not(.hidden) > .split > .split-handle');
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: handle.x, y: handle.y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x - 160, y: handle.y, button: 'left' });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x - 160, y: handle.y, button: 'left', clickCount: 1 });
  await until(`ide.terminal.tabs()[0].layout.a.cols < ${xtermBefore - 5}`, 'pane A narrower');
  const xtermAfter = (await layout()).a.cols;
  await sleep(300);
  const colsAfter = Number(await ask(A, '$Host.UI.RawUI.WindowSize.Width'));
  check(colsBefore === xtermBefore && colsAfter === xtermAfter && colsAfter < colsBefore,
    `dragging the divider resizes the pane's PTY (mode width ${colsBefore} -> ${colsAfter}, xterm ${xtermBefore} -> ${xtermAfter})`);
  const widthB = (await centerOf(`.term-pane[data-session="${B}"]`)).w;
  const colsB = Number(await ask(B, '$Host.UI.RawUI.WindowSize.Width'));
  check(colsB === (await layout()).b.a.cols, `the other side's PTY follows too (${colsB} cols, ${Math.round(widthB)} px)`);
  const h2 = await centerOf('.term-layout:not(.hidden) > .split > .split-handle');
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: h2.x, y: h2.y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: h2.y, button: 'left' });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 0, y: h2.y, button: 'left', clickCount: 1 });
  await sleep(300);
  const minW = (await centerOf(`.term-pane[data-session="${A}"]`)).w;
  check(minW >= 79, `a divider stops at the minimum pane size (${Math.round(minW)} px)`);
  const h3 = await centerOf('.term-layout:not(.hidden) > .split > .split-handle');
  await mouse(h3.x, h3.y, 'left', 2); // double-click resets to half
  await until(`Math.abs(ide.terminal.tabs()[0].layout.ratio - 0.5) < 0.01`, 'divider reset');

  // ---------- focus ----------
  await js(`ide.runAction('Terminal.NextSplitter')`);
  check((await activeId()) === A && (await focusedPane()) === A, 'Next Terminal Split goes from the last pane to the first');
  await js(`ide.runAction('Terminal.NextSplitter')`);
  check((await activeId()) === B && (await focusedPane()) === B, 'Next Terminal Split goes to the next pane');
  await js(`ide.runAction('Terminal.PreviousSplitter')`);
  await js(`ide.runAction('Terminal.PreviousSplitter')`);
  check((await activeId()) === C && (await focusedPane()) === C, 'Previous Terminal Split wraps around to the last pane');
  const aBox = await centerOf(`.term-pane[data-session="${A}"] .xterm-screen`);
  await mouse(aBox.x, aBox.y);
  check((await activeId()) === A && (await focusedPane()) === A && (await js(`document.querySelector('.term-pane.active').dataset.session`)) === String(A),
    'clicking a pane makes it the active one');
  const listed = await js(`['Terminal.SplitRight', 'Terminal.SplitDown', 'Terminal.NextSplitter', 'Terminal.PreviousSplitter'].map(id => ide.actions.find(a => a.id === id)).map(a => a && a.title + ':' + a.keys.length)`);
  check(listed.join() === 'Split Terminal Right:0,Split Terminal Down:0,Next Terminal Split:0,Previous Terminal Split:0', `split actions are in Find Action, unbound by default (${listed})`);

  // ---------- user shortcuts: labels and keys from inside the terminal ----------
  await js(`ide.settings.set('keymap.overrides', { 'Terminal.SplitDown': ['Ctrl+Alt+Shift+F7'], 'Terminal.NextSplitter': ['Ctrl+Alt+Shift+F8'] })`);
  await until(`ide.actions.find(a => a.id === 'Terminal.SplitDown').keys[0] === 'Ctrl+Alt+Shift+F7'`, 'override applied');
  await mouse(aBox.x, aBox.y, 'right');
  await until(`!!document.querySelector('.context-menu')`, 'menu');
  const hint = await js(`[...document.querySelectorAll('.context-menu .menu-item')].find(n => n.firstChild.textContent === 'Split Down').querySelector('.hint-right')?.textContent`);
  const hintRight = await js(`[...document.querySelectorAll('.context-menu .menu-item')].find(n => n.firstChild.textContent === 'Split Right').querySelector('.hint-right')?.textContent || ''`);
  await press('Escape');
  check(hint === 'Ctrl+Alt+Shift+F7' && hintRight === '', `menu hints follow the keymap (Split Down "${hint}", Split Right "${hintRight}")`);
  await js(`document.querySelector('#bottomActions [data-action="terminal-split-down"]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
  check((await js(`document.querySelector('#bottomActions [data-action="terminal-split-down"]').title`)) === 'Split Down (Ctrl+Alt+Shift+F7)', 'toolbar tooltip shows the shortcut');
  await mouse(aBox.x, aBox.y);
  await press('Ctrl+Alt+Shift+F8');
  check((await activeId()) === B && (await focusedPane()) === B, 'a shortcut bound to Next Terminal Split works while a terminal has the keyboard');
  await js(`ide.settings.set('keymap.overrides', {})`);

  // ---------- close a pane: its shell and what runs in it end ----------
  await send(C, 'ping -n 120 127.0.0.1\r');
  await until(`/Pinging|Ping/.test(ide.terminal.text(${C}))`, 'ping running in C', 15000);
  const procsC = withDescendants([pids[2]]);
  check(procsC.some((p) => /ping/i.test(p.name)), `pane C runs a child process (${names(procsC)})`);
  await mouse((await centerOf(`.term-pane[data-session="${C}"] .xterm-screen`)).x, (await centerOf(`.term-pane[data-session="${C}"] .xterm-screen`)).y, 'right');
  await menuPick('Close Session');
  await until(`ide.terminal.sessions().length === 2`, 'pane C closed');
  l = await layout();
  check(l.dir === 'row' && l.a.id === A && l.b.id === B && (await activeId()) === B, `closing a pane gives its room to its neighbour, which becomes active (${JSON.stringify(l)})`);
  check(await gone(procsC), `closing a pane ends its shell and its children (${names(procsC)})`);

  // ---------- `exit` in a pane ----------
  const procsB = withDescendants([pids[1]]);
  await send(B, 'exit\r');
  await until(`ide.terminal.sessions().length === 1`, 'pane B closed by exit');
  l = await layout();
  check(l.id === A && (await js('ide.terminal.tabs().length')) === 1 && (await activeId()) === A, '`exit` in a split pane closes that pane');
  check(await gone(procsB), 'its shell is gone');
  check((await js(`document.querySelector('.term-layout:not(.hidden)').classList.contains('split-mode')`)) === false, 'a single pane has no split outline');

  // ---------- the last pane closes the tab; the tab close button closes every pane ----------
  await js(`ide.terminal.split('down')`);
  await until(`ide.terminal.sessions().length === 2 && ide.terminal.sessions()[1].pid`, 'pane D');
  const D = await activeId();
  await js(`ide.terminal.open({})`);
  await until(`ide.terminal.tabs().length === 2 && ide.terminal.active()?.id`, 'second tab');
  const E = await activeId();
  await js(`ide.runAction('Terminal.CloseSession')`);
  check((await js('ide.terminal.tabs().length')) === 1 && (await activeId()) === D, 'closing the only pane of a tab closes the tab');
  const tabProcs = withDescendants(await js(`ide.terminal.sessions().map(s => s.pid)`));
  await send(D, 'ping -n 120 127.0.0.1\r');
  await sleep(1500);
  const tabProcs2 = withDescendants(await js(`ide.terminal.sessions().map(s => s.pid)`)).filter((p) => !tabProcs.some((q) => q.pid === p.pid));
  // The tab's own context menu.
  const tabBox = await centerOf('.term-tab.active');
  await mouse(tabBox.x, tabBox.y, 'right');
  const tabMenu = await menuPick('Close Tab');
  check(tabMenu.includes('Split Right') && tabMenu.includes('Split Down'), `tab menu has Split Right and Split Down (${tabMenu.join(', ')})`);
  await until(`ide.terminal.tabs().length === 0`, 'tab closed');
  check(await gone([...tabProcs, ...tabProcs2]), `closing a split tab ends every pane's shell (${names([...tabProcs, ...tabProcs2])})`);
  check(E !== D, 'tabs and panes are separate sessions');

  // ---------- closing the project ----------
  await newTab();
  await js(`ide.terminal.split('right')`);
  await until(`ide.terminal.sessions().length === 2 && ide.terminal.sessions()[1].pid`, 'split for project close');
  const P = await js(`ide.terminal.sessions().map(s => s.id)`);
  for (const id of P) await prompt(id);
  for (const id of P) await send(id, 'ping -n 120 127.0.0.1\r');
  await sleep(1500);
  const projProcs = withDescendants(await js(`ide.terminal.sessions().map(s => s.pid)`));
  const root = await js('ide.root');
  // An installer session (not tied to the project) in a tab of its own.
  await js(`ide.terminal.open({ name: 'Installer', projectless: true }).then(() => true)`);
  await until(`ide.terminal.sessions().length === 3 && ide.terminal.sessions()[2].pid`, 'installer session');
  const inst = await js(`ide.terminal.sessions()[2].id`);
  await prompt(inst);
  const instProcs = withDescendants([await js(`ide.terminal.sessions()[2].pid`)]);
  // ide.ui.confirm is stubbed: it records the question and answers window.__confirmAnswer.
  await js(`(window.__confirms = [], window.__confirmAnswer = false, ide.ui.confirm = async (text, o = {}) => { window.__confirms.push({ text, title: o.title, ok: o.ok }); return window.__confirmAnswer; }, true)`);
  check((await js('ide.closeProject()')) === false && (await js('ide.root')) === root, 'Cancel in the terminate prompt keeps the project open');
  let asked = await js('window.__confirms');
  check(asked.length === 1 && /^2 terminal sessions are still running: .+\. Terminate them\?$/.test(asked[0].text) && asked[0].title === 'Terminate Processes' && asked[0].ok === 'Terminate',
    `closing the project with running sessions asks first, counting only the project's sessions (${JSON.stringify(asked)})`);
  check((await js(`ide.terminal.sessions().filter(s => !s.exited).length`)) === 3 && procsAlive(projProcs), 'after Cancel every session still runs');
  const other = await js(`ide.util.joinPath(ide.root, 'splitdir')`);
  await js(`ide.api.invoke('trust:add', ${JSON.stringify(other)}).then(() => true)`);
  check((await js(`ide.openProject(${JSON.stringify(other)})`)) === false && (await js('ide.root')) === root && (await js('window.__confirms.length')) === 2,
    'opening another project asks too, and Cancel keeps the current one');
  await js(`(window.__confirmAnswer = true, true)`);
  check((await js('ide.closeProject()')) === true, 'Terminate closes the project');
  await until(`ide.terminal.sessions().length === 1`, 'sessions closed with the project');
  check(await gone(projProcs), `closing the project ends its terminals (${names(projProcs)})`);
  check((await js(`ide.terminal.sessions()[0].id`)) === inst && !(await js(`ide.terminal.sessions()[0].exited`)) && procsAlive(instProcs),
    'the installer session is not the project\'s: it keeps running after the project closes');
  await js(`ide.openProject(${JSON.stringify(root)})`);
  await until(`ide.root === ${JSON.stringify(root)} && document.getElementById('welcome').classList.contains('hidden')`, 'project back');
  check((await js(`ide.terminal.sessions().map(s => s.id).join()`)) === String(inst), 'the installer session is still there when a project opens');
  // Only an exited installer session is left: switching projects no longer asks.
  await js(`ide.terminal.close(${inst})`);
  await until(`ide.terminal.sessions().length === 0`, 'installer session closed');
  check(await gone(instProcs), 'closing the installer session ends it');
  await js(`(window.__confirms = [], true)`);
  await newTab();
  const X = await activeId();
  await prompt(X);
  await send(X, 'exit\r');
  await until(`ide.terminal.sessions()[0]?.exited`, 'exited session');
  check((await js('ide.closeProject()')) === true && (await js('window.__confirms.length')) === 0, 'sessions that have exited close with the project without a question');
  await js(`ide.openProject(${JSON.stringify(root)})`);
  await until(`ide.root === ${JSON.stringify(root)} && document.getElementById('welcome').classList.contains('hidden')`, 'project back again');

  // ---------- quitting the app ----------
  await newTab();
  await js(`(ide.toolWindows.get('Terminal').isVisible() || ide.toolWindows.get('Terminal').show(), true)`);
  await js(`ide.terminal.split('down')`);
  await until(`ide.terminal.sessions().length === 2 && ide.terminal.sessions()[1].pid`, 'split for exit');
  const Q = await js(`ide.terminal.sessions().map(s => s.id)`);
  for (const id of Q) await prompt(id);
  for (const id of Q) await send(id, 'ping -n 120 127.0.0.1\r');
  await sleep(1500);
  const appProcs = withDescendants(await js(`ide.terminal.sessions().map(s => s.pid)`));
  await shot('split.png');
  js(`ide.runAction('Exit')`).catch(() => {});
  const end = Date.now() + 20000;
  while (alive(t.pid) && Date.now() < end) await sleep(250);
  check(!alive(t.pid), 'Exit quits the app');
  check(await gone(appProcs), `quitting ends every pane's shell (${names(appProcs)})`);
  finished = true;
} catch (err) {
  check(false, err.message);
  await shot('failure.png').catch(() => {});
}

// Persistence: terminal tabs are not restored when a project reopens, so split layouts are not either.

// ---------- Korean ----------
const k = await launch({ fixture: 'core', port: 9211, name: 'terminal-split-ko', lang: 'ko-KR' });
try {
  await k.press('Alt+F12');
  await k.until(`ide.terminal.sessions()[0]?.id`, 'ko session');
  await k.js(`ide.terminal.split('right')`);
  await k.until(`ide.terminal.sessions().length === 2 && ide.terminal.sessions()[1].id`, 'ko split');
  const box = await k.js(`(() => { const r = document.querySelector('.term-pane.active .xterm-screen').getBoundingClientRect(); return { x: r.x + 20, y: r.y + 20 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await k.cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'right', clickCount: 1 });
  await k.until(`!!document.querySelector('.context-menu')`, 'ko menu');
  const items = await k.js(`[...document.querySelectorAll('.context-menu .menu-item')].map(n => n.firstChild.textContent)`);
  await k.press('Escape');
  const tab = await k.js(`(() => { const r = document.querySelector('.term-tab').getBoundingClientRect(); return { x: r.x, y: r.y }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await k.cdp('Input.dispatchMouseEvent', { type, x: tab.x + 10, y: tab.y + 5, button: 'right', clickCount: 1 });
  await k.until(`!!document.querySelector('.context-menu')`, 'ko tab menu');
  const tabItems = await k.js(`[...document.querySelectorAll('.context-menu .menu-item')].map(n => n.firstChild.textContent)`);
  await k.press('Escape');
  const titles = await k.js(`['Terminal.SplitRight', 'Terminal.SplitDown', 'Terminal.NextSplitter', 'Terminal.PreviousSplitter', 'Terminal.CloseSession'].map(id => ide.actions.find(a => a.id === id).title)`);
  const tips = await k.js(`[...document.querySelectorAll('#bottomActions [data-action^="terminal-split"]')].map(b => b.title)`);
  const ko = JSON.parse(readFileSync(new URL('../renderer/features/terminal/locales/ko.json', import.meta.url), 'utf8'));
  const missing = (await missingTranslations(k)).filter((m) => m in ko || /split|terminal|session|tab/i.test(m));
  check(items.includes('오른쪽으로 분할') && items.includes('아래로 분할') && tabItems.includes('탭 닫기') && titles.every((x) => /[가-힣]/.test(x)) && tips.every((x) => /[가-힣]/.test(x)) && !missing.length,
    `Korean menus, actions and tooltips (${items.join(', ')} | ${tabItems.join(', ')} | ${titles.join(', ')} | ${tips.join(', ')}; missing: ${missing.join(', ') || 'none'})`);
  // The terminate prompt in Korean (ide.ui.confirm stubbed to answer Cancel).
  await k.js(`(window.__confirms = [], ide.ui.confirm = async (text, o = {}) => { window.__confirms.push({ text, title: o.title, ok: o.ok }); return false; }, true)`);
  const kept = (await k.js('ide.closeProject()')) === false;
  const koAsked = await k.js('window.__confirms');
  check(kept && koAsked.length === 1 && /^터미널 세션 2개가 아직 실행 중입니다: .+\. 모두 종료하시겠습니까\?$/.test(koAsked[0].text) && koAsked[0].title === '프로세스 종료' && koAsked[0].ok === '종료',
    `Korean terminate prompt (${JSON.stringify(koAsked)})`);
  // A page reload (Trust Project reopens the page) ends the window's sessions in main instead of leaving them unseen.
  const reloadProcs = withDescendants(await k.js(`ide.terminal.sessions().map(s => s.pid)`));
  await k.cdp('Page.reload');
  await sleep(500);
  await k.until('window.__ideReady === true', 'ko IDE ready after reload', 30000);
  check(reloadProcs.length >= 2 && await gone(reloadProcs), `a page reload ends the sessions of the page it replaced (${names(reloadProcs)})`);
} catch (err) {
  check(false, `Korean: ${err.message}`);
}
k.close();
if (k.consoleErrors.length) check(false, `Korean instance exceptions: ${k.consoleErrors.join(' | ')}`);
if (!finished) console.log('the main run stopped early');
t.finish();
