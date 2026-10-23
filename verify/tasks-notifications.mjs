// Background tasks (ide.tasks: status bar widget, popup, cancel, done/fail) and notifications (ide.notifications:
// balloons, the Notifications tool window with actions, unread badge, Don't Show Again, Clear All, the event log kept
// across restarts, written in batches and on quit), the Install Manager and semantic indexing as tasks (fake backends),
// and Korean. Ports 9330-9333.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, tempDir } from './lib.mjs';
import { englishLeaks, missingTranslations } from './i18n-lib.mjs';

const S = JSON.stringify;
const results = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const live = [];
const MINE = /process|task|notification|balloon|Show Log|Don't Show|Mark All|Clear All|Earlier|semantic index|Jupyter kernel|Downloading PyIDE|failed|left$/i;

const widget = (t) => t.js(`(() => { const w = document.querySelector('#bgTasks'); return { shown: !w.classList.contains('hidden') && !!w.getClientRects().length,
  label: w.querySelector('.bg-tasks-label').textContent, title: w.title, width: w.querySelector('.bg-fill').style.width,
  indeterminate: w.querySelector('.bg-bar').classList.contains('indeterminate') }; })()`);
const popupRows = (t) => t.js(`[...document.querySelectorAll('#bgTasksPopup .bg-popup-row')].map((r) => ({ title: r.querySelector('.bg-popup-title').textContent,
  text: r.querySelector('.bg-popup-text')?.textContent || '', width: r.querySelector('.bg-fill').style.width, cancel: !!r.querySelector('.bg-popup-cancel') }))`);
const balloon = (title) => `[...document.querySelectorAll('.ide-balloon')].find((b) => b.querySelector('.ide-balloon-title').textContent === ${S(title)})`;
const listed = (t) => t.js(`[...document.querySelectorAll('.notes-list .notes-item:not(.earlier)')].map((n) => ({ title: n.querySelector('.notes-title').textContent,
  actions: [...n.querySelectorAll('.notes-action')].map((a) => a.textContent), unread: n.classList.contains('unread'), kind: n.className }))`);
const badge = (t) => t.js(`document.querySelector('.stripe-btn[data-tool="Notifications"]').dataset.badge || ''`);
const clickAction = (t, title, label) => t.js(`(() => {
  const n = [...document.querySelectorAll('.notes-list .notes-item')].find((x) => x.querySelector('.notes-title').textContent === ${S(title)});
  [...n.querySelectorAll('.notes-action')].find((a) => a.textContent === ${S(label)}).click();
  return true;
})()`);
// Closes an instance after checking it threw no renderer exceptions.
const done = (t) => {
  check(!t.consoleErrors.length, `no renderer exceptions in ${path.basename(t.outDir)} (${t.consoleErrors.join(' | ')})`);
  t.close();
  live.splice(live.indexOf(t), 1);
};
const eventLog = (t) => { const f = path.join(t.userData, 'notifications', 'log.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; };
const untilLog = async (t, pred, label, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; await t.sleep(100)) { const l = eventLog(t); if (l && pred(l)) return true; }
  throw new Error(`timeout waiting for the event log: ${label}`);
};

try {
  // ---------- background tasks ----------
  const a = await launch({ fixture: 'tasks-notifications', port: 9330, name: 'tasks-notifications' });
  live.push(a);
  const { js, until } = a;
  check(await js(`typeof ide.tasks?.start === 'function' && typeof ide.notifications?.notify === 'function'`), 'ide.tasks and ide.notifications exist');
  check(!(await widget(a)).shown, 'no task: the status bar widget is hidden');
  await js(`(window.__a = ide.tasks.start({ title: 'Alpha job', fraction: 0.25 }), true)`);
  await until(`!document.querySelector('#bgTasks').classList.contains('hidden')`, 'widget shown');
  let w = await widget(a);
  check(w.label === 'Alpha job' && w.width === '25%' && !w.indeterminate, `one task: its title and a 25% bar (${S(w)})`);
  await js(`(window.__a.update({ fraction: 0.5, text: 'halfway there' }), true)`);
  await until(`document.querySelector('#bgTasks .bg-fill').style.width === '50%'`, 'progress update');
  check((await widget(a)).title.includes('halfway there'), 'update() changes the bar and the text (tooltip)');
  await js(`(window.__b = ide.tasks.start({ title: 'Beta job', onCancel: () => { window.__cancelled = (window.__cancelled || 0) + 1; } }), true)`);
  await until(`document.querySelector('#bgTasks .bg-tasks-label').textContent === '2 processes running'`, '2 processes');
  w = await widget(a);
  check(w.indeterminate, `two tasks: "2 processes running" and the newest task's indeterminate bar (${S(w)})`);
  check(await js(`ide.tasks.list().map((x) => x.title + ':' + x.cancellable).join()`) === 'Alpha job:false,Beta job:true', 'ide.tasks.list() lists both; onCancel makes a task cancellable');
  // The widget refits the status bar when its label changes, so a click may land before it settles; click again then.
  const twoRows = `document.querySelectorAll('#bgTasksPopup .bg-popup-row').length === 2`;
  for (let i = 0; i < 3 && !(await js(twoRows)); i++) { await a.click('#bgTasks'); await until(twoRows, 'popup', 3000).catch(() => {}); }
  await until(twoRows, 'popup with two rows');
  let rows = await popupRows(a);
  check(rows[0].title === 'Alpha job' && rows[0].width === '50%' && rows[0].text === 'halfway there' && !rows[0].cancel && rows[1].title === 'Beta job' && rows[1].cancel,
    `clicking the widget lists every task with progress, text and Cancel where cancellable (${S(rows)})`);
  await a.shot('tasks-popup.png');
  await a.click('#bgTasksPopup .bg-popup-row[data-task] .bg-popup-cancel');
  await until(`document.querySelectorAll('#bgTasksPopup .bg-popup-row').length === 1`, 'cancelled row gone');
  check(await js(`window.__cancelled === 1 && !window.__b.active && window.__b.cancelled`), 'Cancel calls onCancel once and ends the task');
  await until(`document.querySelector('#bgTasks .bg-tasks-label').textContent === 'Alpha job'`, 'back to one task');
  await js(`(window.__b.done(), window.__b.update({ fraction: 1 }), true)`);
  check(await js(`ide.tasks.list().length === 1`), 'done/update after cancel are ignored');
  await js(`(window.__a.done(), true)`);
  await until(`document.querySelector('#bgTasks').classList.contains('hidden') && !document.querySelector('#bgTasksPopup')`, 'widget hidden and popup closed');
  check(true, 'done() removes the last task: the widget hides and the popup closes');

  // ---------- notifications ----------
  await js(`(ide.notifications.clear(), true)`);
  await js(`(ide.tasks.start({ title: 'Gamma job' }).fail(new Error('the disk is full')), true)`);
  await until(`!!${balloon('Gamma job failed')}`, 'failure balloon');
  check(await js(`(() => { const b = ${balloon('Gamma job failed')}; return b.classList.contains('error') && b.textContent.includes('the disk is full') && [...b.querySelectorAll('.ide-balloon-action')].some((x) => x.textContent === 'Show Log'); })()`),
    'fail(err) ends the task and posts an error notification with the error and Show Log');
  check(await js(`ide.tasks.list().length === 0 && (ide.tasks.start({ title: 'Quiet' }).fail(), ide.notifications.list().length === 1)`), 'fail() without an error only ends the task');
  await js(`(window.__note = ide.notifications.notify({ title: 'Deploy finished', text: 'All good', kind: 'ok', group: 'Test Group',
    actions: [{ label: 'Open Report', run: (n) => { window.__did = (window.__did || 0) + 1; n.expire(); } }] }), true)`);
  await until(`!!${balloon('Deploy finished')}`, 'balloon');
  check(await js(`[...${balloon('Deploy finished')}.querySelectorAll('.ide-balloon-action')].map((x) => x.textContent).join() === 'Open Report'`), 'a notification shows a balloon with its actions');
  await until(`document.querySelector('.stripe-btn[data-tool="Notifications"]').dataset.badge === '2'`, 'badge 2');
  check(await js(`!document.querySelector('.stripe-btn[data-tool="Notifications"]').classList.contains('hidden')`), 'the Notifications stripe button is on the right sidebar with an unread badge (2)');
  // vcs.notify goes through ide.notifications (group Git; clicking the balloon still opens the Git console).
  await js(`(ide.vcs.notify('Pushed 1 commit to origin/master', 'raw git text', 'ok', true), true)`);
  await until(`ide.notifications.list().some((e) => e.group === 'Git' && e.title === 'Pushed 1 commit to origin/master')`, 'git note recorded');
  check(await js(`${balloon('Pushed 1 commit to origin/master')}.classList.contains('vcs-note') && !!${balloon('Pushed 1 commit to origin/master')}.querySelector('[data-user-text]')`),
    'Git notifications (vcs.notify) are recorded, keep the vcs-note class and mark raw text as user data');

  await a.click('.stripe-btn[data-tool="Notifications"]');
  await until(`ide.toolWindows.get('Notifications').isVisible() && document.querySelectorAll('.notes-list .notes-item').length === 3`, 'tool window with 3 notes');
  let notes = await listed(a);
  check(notes.map((n) => n.title).join(' | ') === 'Pushed 1 commit to origin/master | Deploy finished | Gamma job failed', `the tool window lists the session's notifications newest first (${notes.map((n) => n.title).join(' | ')})`);
  check(notes[1].actions.join() === 'Open Report' && notes[2].actions.join() === 'Show Log', 'actions stay usable in the tool window; errors link to the IDE log');
  await until(`(document.querySelector('.stripe-btn[data-tool="Notifications"]').dataset.badge || '') === '' && ide.notifications.unread() === 0`, 'badge cleared');
  check(true, 'opening the tool window marks everything read and clears the badge');
  await a.shot('notifications-window.png');
  await clickAction(a, 'Deploy finished', 'Open Report');
  await until(`window.__did === 1`, 'action ran');
  await until(`![...document.querySelectorAll('.notes-list .notes-action')].some((x) => x.textContent === 'Open Report')`, 'expired action hidden');
  check(await js(`window.__note.expired`), 'an action runs from the tool window; once the notification expires its action is no longer offered');
  await clickAction(a, 'Gamma job failed', 'Show Log');
  await until(`ide.tabs.some((t) => /pyide\\.log$/i.test(t.path || ''))`, 'log opened');
  check(true, 'Show Log on an error notification opens the IDE log');
  // A notification posted while the window is open is read at once.
  await js(`(ide.notifications.notify({ title: 'Seen at once' }), true)`);
  await until(`document.querySelector('.notes-list .notes-title')?.textContent === 'Seen at once'`, 'new note listed');
  check(await badge(a) === '', 'a notification posted while the tool window is open does not raise the badge');

  // Don't Show Again for a group: recorded, no balloon; the tool window can bring balloons back.
  await js(`(window.__g = ide.notifications.notify({ title: 'Group one', group: 'Test Group' }), true)`);
  await until(`!!${balloon('Group one')}`, 'group balloon');
  await js(`(${balloon('Group one')}.querySelector('.ide-balloon-more').click(), true)`);
  await until(`!!document.querySelector('.context-menu')`, 'balloon menu');
  check(await js(`document.querySelector('.context-menu').textContent.includes("Don't Show Again")`), "the balloon menu offers Don't Show Again for its group");
  await a.click('.context-menu .menu-item');
  await until(`ide.notifications.hiddenGroups().includes('Test Group') && !${balloon('Group one')}`, 'group hidden');
  await js(`(ide.notifications.notify({ title: 'Group two', group: 'Test Group' }), true)`);
  await until(`ide.notifications.list().some((e) => e.title === 'Group two')`, 'muted note recorded');
  // The tool window redraws on the next animation frame; a balloon would have been added by notify() itself.
  await until(`[...document.querySelectorAll('.notes-list .notes-item:not(.earlier) .notes-title')].some((n) => n.textContent === 'Group two')`, 'muted note listed');
  check(!(await js(`!!${balloon('Group two')}`)) && (await listed(a)).some((n) => n.title === 'Group two'), "after Don't Show Again the group's notifications are recorded without a balloon");
  check(await js(`ide.settings.get('notifications.hiddenGroups', []).includes('Test Group') && !!document.querySelector('#rightActions [data-action="restoreGroups"]')`), 'the choice is a setting; the tool window offers to show the balloons again');
  await a.click('#rightActions [data-action="restoreGroups"]');
  await until(`!ide.notifications.hiddenGroups().length && !document.querySelector('#rightActions [data-action="restoreGroups"]')`, 'groups restored');
  await js(`(ide.notifications.notify({ title: 'Group three', group: 'Test Group' }), true)`);
  check(await until(`!!${balloon('Group three')}`, 'balloon again'), 'Show Balloons Again brings the balloons back');

  // ---------- Install Manager jobs as tasks ----------
  await js(`(() => {
    window.__inst = { aborted: false, release: null };
    (ide.installables ||= []).push(
      { id: 'tn:slow', category: 'tn', name: 'Slow Tool', description: 'Waits.', status: async () => ({ installed: false }),
        install: (log, progress, signal) => new Promise((resolve, reject) => {
          log('fetching slow-tool 1.0'); progress(0.4);
          window.__inst.release = resolve;
          signal.addEventListener('abort', () => { window.__inst.aborted = true; reject(new Error('aborted')); });
        }) },
      { id: 'tn:fail', category: 'tn', name: 'Broken Tool', description: 'Fails.', status: async () => ({ installed: false }),
        install: async (log) => { log('starting'); throw new Error('no space left on device'); } });
    ide.emit('installablesChanged');
    ide.installer.open('tn');
    return true;
  })()`);
  const card = (id) => `.inst-card[data-id="${id}"]`;
  await until(`document.querySelector('${card('tn:slow')}')?.dataset.phase === 'notInstalled'`, 'slow card checked', 30000);
  await js(`(document.querySelector('${card('tn:slow')} button[data-op="install"]').scrollIntoView({ block: 'center' }), true)`);
  await a.click(`${card('tn:slow')} button[data-op="install"]`);
  await until(`ide.tasks.list().some((x) => x.title === 'Install: Slow Tool' && x.fraction === 0.4 && x.text === 'fetching slow-tool 1.0')`, 'install task');
  check(true, 'an Install Manager job is a background task with its progress and last log line');
  await a.click('#bgTasks');
  await until(`!!document.querySelector('#bgTasksPopup .bg-popup-cancel')`, 'install task cancellable in popup');
  await a.click('#bgTasksPopup .bg-popup-cancel');
  await until(`window.__inst.aborted && document.querySelector('${card('tn:slow')}').dataset.phase === 'notInstalled' && !ide.tasks.list().length`, 'install cancelled');
  check(true, 'Cancel in the popup cancels the install (the card goes back to Not installed)');
  await js(`(document.querySelector('${card('tn:slow')} button[data-op="install"]').scrollIntoView({ block: 'center' }), true)`);
  await a.click(`${card('tn:slow')} button[data-op="install"]`);
  await until(`!!window.__inst.release && ide.tasks.list().length === 1`, 'second install running');
  await js(`(window.__inst.release(), true)`);
  await until(`!ide.tasks.list().length && ide.notifications.list().some((e) => e.title === 'Install: Slow Tool' && e.kind === 'ok')`, 'install finished notification');
  check(await js(`ide.notifications.list().find((e) => e.title === 'Install: Slow Tool').actions.some((x) => x.label === 'Open Install Manager')`), 'a finished install ends its task and posts a notification with Open Install Manager');
  await js(`(document.querySelector('${card('tn:fail')} button[data-op="install"]').scrollIntoView({ block: 'center' }), true)`);
  await a.click(`${card('tn:fail')} button[data-op="install"]`);
  await until(`ide.notifications.list().some((e) => e.title === 'Install: Broken Tool' && e.kind === 'error' && e.text === 'no space left on device')`, 'install failed notification');
  check(await js(`!ide.tasks.list().length`), 'a failed install posts an error notification with the reason');

  // ---------- Clear All and the event log ----------
  await js(`(ide.toolWindows.get('Notifications').show(), true)`);
  await until(`!!document.querySelector('#rightActions [data-action="clearAll"]')`, 'Clear All button');
  await a.click('#rightActions [data-action="clearAll"]');
  await until(`!document.querySelector('.notes-list .notes-item') && document.querySelector('.notes-empty')?.textContent === 'No notifications'`, 'cleared');
  await untilLog(a, (l) => l.length === 0, 'cleared log');
  check(await js(`ide.notifications.list().length === 0`), 'Clear All empties the tool window, the session list and the event log');
  await js(`(ide.toolWindows.get('Notifications').hide(), true)`);
  await js(`(() => {
    ide.notifications.notify({ title: 'First kept', text: 'one' });
    ide.notifications.notify({ title: '배포 완료', text: '한글 본문입니다', kind: 'ok' });
    ide.notifications.notify({ title: 'Last kept', text: 'three', kind: 'warn', actions: [{ label: 'Retry', run: () => {} }] });
    return true;
  })()`);
  await untilLog(a, (l) => l.map((e) => e.title).join() === 'First kept,배포 완료,Last kept', 'three entries');
  check(eventLog(a)[1].text === '한글 본문입니다' && eventLog(a)[2].kind === 'warn', 'each notification is appended to <userData>/notifications/log.json (Korean text kept)');
  await until(`document.querySelector('.stripe-btn[data-tool="Notifications"]').dataset.badge === '3'`, 'badge 3');
  done(a);

  // ---------- after a restart, in Korean ----------
  const k = await launch({ fixture: 'tasks-notifications', port: 9331, name: 'tasks-notifications-ko', lang: 'ko-KR', userData: a.userData });
  live.push(k);
  check((await badge(k)) === '', 'a restart starts with no unread notifications');
  await k.click('.stripe-btn[data-tool="Notifications"]');
  await k.until(`document.querySelectorAll('.notes-list .notes-item.earlier').length === 3`, 'earlier notes listed');
  const earlier = await k.js(`[...document.querySelectorAll('.notes-list .notes-item.earlier')].map((n) => n.querySelector('.notes-title').textContent + '|' + n.querySelectorAll('.notes-action').length)`);
  check(earlier.join() === 'Last kept|0,배포 완료|0,First kept|0' && await k.js(`document.querySelector('.notes-section').textContent === '이전 세션'`),
    `the last session's notifications come back under Earlier sessions, newest first, without actions (${earlier.join()})`);
  await k.js(`(() => { ide.notifications.notify({ title: '오류', text: 'x', kind: 'error', group: 'Background Tasks' }); window.__k1 = ide.tasks.start({ title: '작업 하나', fraction: 0.3 }); window.__k2 = ide.tasks.start({ title: '작업 둘', onCancel: () => {} }); return true; })()`);
  await k.until(`document.querySelector('#bgTasks .bg-tasks-label').textContent === '프로세스 2개 실행 중'`, 'Korean processes label');
  await k.click('#bgTasks');
  await k.until(`document.querySelectorAll('#bgTasksPopup .bg-popup-row').length === 2`, 'Korean popup');
  // The titles and texts posted by the first instance are test data in English.
  const leaks = await englishLeaks(k, '#bgTasks, #bgTasksPopup, #rightPanel, .ide-balloons', ['First', 'Last', 'kept', 'one', 'three']);
  check(!leaks.length, `tasks widget, popup, Notifications window and balloons are Korean (${leaks.map((l) => l.text).join(' | ')})`);
  check(await k.js(`document.querySelector('#rightTitle').textContent === '알림' && document.querySelector('#bgTasksPopup .bg-popup-cancel').title === '취소'`), 'the tool window is 알림 and Cancel is 취소');
  await k.shot('korean.png');
  await k.js(`(window.__k1.done(), window.__k2.done(), true)`);
  const missing = (await missingTranslations(k)).filter((s) => MINE.test(s));
  check(!missing.length, `no missing translations (${missing.join(' | ')})`);
  done(k);

  // ---------- a burst of notifications: one batched write of the event log; what is pending at Exit is kept ----------
  const q = await launch({ fixture: 'tasks-notifications', port: 9333, name: 'tasks-notifications-burst' });
  live.push(q);
  const logFile = path.join(q.userData, 'notifications', 'log.json');
  const burstStart = Date.now();
  await q.js(`(() => { for (let i = 0; i < 40; i++) ide.notifications.notify({ title: 'Burst ' + i, text: i === 0 ? 'x'.repeat(30000) : 'short' }); return true; })()`);
  let partial = 0;
  for (const end = Date.now() + 10000; Date.now() < end; await q.sleep(20)) {
    const n = (eventLog(q) || []).filter((e) => e.title.startsWith('Burst ')).length;
    if (n === 40) break;
    if (n) partial = Math.max(partial, n);
  }
  const firstWrite = existsSync(logFile) ? statSync(logFile).mtimeMs - burstStart : -1;
  check(eventLog(q)?.filter((e) => e.title.startsWith('Burst ')).length === 40 && !partial && firstWrite >= 200,
    `a burst of 40 notifications is written once, after the burst (${firstWrite} ms after it started; ${partial} entries seen in a partial write)`);
  check(eventLog(q).find((e) => e.title === 'Burst 0').text.length === 2000, 'a 30 KB notification text is saved as its first 2000 characters');
  await q.js(`(['Quit 1', 'Quit 2', 'Quit 3'].forEach((title) => ide.notifications.notify({ title, text: 'at exit' })), true)`);
  q.js(`ide.runAction('Exit')`).catch(() => {});
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const end = Date.now() + 20000; alive(q.pid) && Date.now() < end; await q.sleep(100));
  check(!alive(q.pid) && (eventLog(q) || []).slice(-3).map((e) => e.title).join() === 'Quit 1,Quit 2,Quit 3',
    `notifications posted right before Exit are saved on quit (${(eventLog(q) || []).slice(-3).map((e) => e.title).join()})`);
  done(q);

  // ---------- semantic indexing as a task (fake backend, slowed per page of files) ----------
  const proj = tempDir('tn-semantic');
  for (let i = 0; i < 800; i++) {
    const dir = path.join(proj, `pkg${i % 8}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `m${i}.py`), `def helper_${i}(x):\n    return x + ${i}\n`);
  }
  const s = await launch({ projectDir: proj, port: 9332, name: 'tasks-notifications-semantic', env: { PYIDE_SEMANTIC_FAKE_PAGE_MS: '1500' } });
  live.push(s);
  await s.until(`ide.tasks.list().some((x) => x.title === 'Updating semantic index' && x.fraction !== null && x.cancellable)`, 'semantic task', 120000);
  const semTask = await s.js(`ide.tasks.list().find((x) => x.title === 'Updating semantic index')`);
  check(/^Indexing \d+\/\d+/.test(semTask.text), `semantic indexing shows as a cancellable background task with progress (${semTask.text}, ${Math.round(semTask.fraction * 100)}%)`);
  check(await s.js(`!document.querySelector('#semanticStatus').classList.contains('hidden')`), 'the semantic status item keeps working beside it');
  await s.click('#bgTasks');
  await s.until(`!!document.querySelector('#bgTasksPopup .bg-popup-cancel')`, 'semantic popup');
  await s.click('#bgTasksPopup .bg-popup-cancel');
  await s.until(`ide.semantic.progress()?.paused === true && !ide.tasks.list().length`, 'semantic paused', 15000);
  check(true, 'Cancel on the semantic task pauses indexing and removes the task');
  await s.js(`ide.api.invoke('semantic:pause', false).then(() => true)`);
  await s.until(`ide.tasks.list().some((x) => x.title === 'Updating semantic index')`, 'semantic task back', 30000);
  await s.until(`!ide.tasks.list().length && ide.semantic.progress()?.phase === 'ready'`, 'semantic done', 120000);
  check(true, 'after Resume the task comes back and ends when the index is ready');
  done(s);
} catch (err) {
  check(false, err.stack || err.message);
} finally {
  for (const t of live) t.close();
}
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
