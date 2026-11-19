// A server's scheduled tasks (main/minecraft/schedule.js, renderer/features/minecraft/schedule.js), first as rules and
// then in a Korean craft window against the stand-in server (verify/fixtures/craft-health/stand-in-server.cjs), with
// PYIDE_MC_SCHEDULE_MS running the schedule's clock 20 times as fast and announcing 20, 10 and 5 seconds before. No
// real server, game, launcher, EULA or network.
// Checks: what is kept of a task list; a time of day on the chosen days; the announcements before a restart; an
// occurrence already under way when the server started is not this run's; a skipped one is passed over; the settings
// tab's section adds, edits and deletes tasks, saved at once; a restart and a command set for the same minute are both
// done, the command first, with the players told before, and the server runs again; Skip This Time calls one stop off;
// a stop without announcements stops the server and is not reported as a crash. Port 9748; the stand-in listens on
// 25741.
// Usage: node verify/craft-schedule.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { launch } from './lib.mjs';

const S = JSON.stringify;
const R = createRequire(import.meta.url)('../main/minecraft/schedule.js');
let passed = 0;
let failed = 0;
const rule = (ok, text) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`); if (ok) passed++; else failed++; };

// ---------- the rules ----------
{
  const kept = R.normalize([{ kind: 'restart', time: '4:00' }, { kind: 'command', time: '12:30', command: ' /say hi ', days: [1, 1, 9, 3] }, { kind: 'command', time: '01:00' },
    { kind: 'format', time: '01:00' }, { kind: 'stop', time: '25:00' }, { kind: 'command', time: '02:00', command: 'say a\nstop' }, null, { id: 't1', kind: 'stop', time: '23:59', warn: false, days: [0, 1, 2, 3, 4, 5, 6] }]);
  rule(S(kept) === S([{ id: 't1', on: true, kind: 'restart', time: '04:00', days: [], warn: true }, { id: 't2', on: true, kind: 'command', time: '12:30', days: [1, 3], command: 'say hi' },
    { id: 't3-2', on: true, kind: 'stop', time: '23:59', days: [], warn: false }]),
  `a list keeps the tasks with a time and a kind, a command of one line without its slash, and one id each (${S(kept)})`);
  rule(R.normalize(Array.from({ length: 30 }, () => ({ kind: 'stop', time: '01:00' }))).length === R.TASK_LIMIT, `a server has ${R.TASK_LIMIT} tasks at most`);
  const at = (d, h, m, s = 0) => new Date(2026, 10, d, h, m, s).getTime(); // 19 November 2026 is a Thursday
  const restart = kept[0];
  rule(R.occurrence(restart, at(19, 3, 50)) === at(19, 4, 0) && R.occurrence(restart, at(19, 4, 0)) === at(20, 4, 0), 'a task of every day comes at its time today, then tomorrow');
  rule(R.occurrence(kept[1], at(19, 13, 0)) === at(23, 12, 30) && R.occurrence(kept[1], at(23, 12, 30)) === at(25, 12, 30), 'a task of Monday and Wednesday waits for those days');
  const long = at(19, 1, 0);
  const steps = [];
  for (let after = at(19, 3, 50), i = 0; i < 4; i++) { const st = R.nextStep([restart], after, long); steps.push([new Date(st.at).toTimeString().slice(0, 8), st.warn ?? st.kind]); after = st.at; }
  const [w1, w2, w3] = R.WARN_SECONDS;
  rule(steps.length === 4 && S(steps.map((x) => x[1])) === S([w1, w2, w3, 'restart']) && steps[3][0] === '04:00:00', `a restart is announced three times, then done at its time (${S(steps)})`);
  const late = R.nextStep([restart], at(19, 3, 59, 30), at(19, 3, 59, 30));
  rule(late.occurrence === at(20, 4, 0), `a server started inside the announcements is not restarted by them: the next one is tomorrow's (${new Date(late.occurrence).toString().slice(0, 21)})`);
  const skipped = R.nextStep([restart], at(19, 3, 50), long, new Set([`t1@${at(19, 4, 0)}`]));
  rule(skipped.occurrence === at(20, 4, 0), 'a skipped occurrence is passed over');
  const proxy = R.nextStep([restart], at(19, 3, 50), long, new Set(), true);
  rule(proxy.at === at(19, 4, 0) && !proxy.warn, 'a proxy, which has no say, gets no announcement');
  const both = R.nextSteps([restart, { id: 'c', on: true, kind: 'command', time: '04:00', days: [], command: 'save-all' }, { id: 'off', on: false, kind: 'stop', time: '04:00', days: [], warn: false }], at(19, 3, 59, 59), long);
  rule(S(both.map((x) => x.kind)) === S(['command', 'restart']), `tasks of the same minute are all due, a command before the restart, and a task that is off is not (${S(both.map((x) => x.kind))})`);
}

// ---------- in the app ----------
const work = mkdtempSync(path.join(tmpdir(), 'pyide-craft-schedule-'));
const project = path.join(work, 'project');
const write = (p, data) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, data); };
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const dir = path.join(project, 'servers', 'night');
write(path.join(dir, 'pyide-server.json'), S({ kind: 'fabric', mc: '26.3', loader: '0.17.0', build: null, java: 21, memory: '2G', launch: { jar: 'server.jar' } }));
write(path.join(dir, 'server.properties'), 'server-port=25741\nmotd=night\n');
write(path.join(dir, 'stand-in.json'), S({ port: 25741 }));
const starts = () => read(path.join(dir, 'starts.log')).trim().split('\n').filter(Boolean).length;
const commands = () => read(path.join(dir, 'commands.log')).split(/\r?\n/).filter(Boolean);
const saved = () => JSON.parse(read(path.join(dir, 'pyide-server.json'))).schedule;
const standIn = path.resolve('verify/fixtures/craft-health/stand-in-server.cjs');
const java = path.join(work, 'java');
write(path.join(java, 'bin', 'java.exe'), 'never run');
const CLOSED = 'http://127.0.0.1:1';
const env = { PYIDE_CRAFT_HOME: project, PYIDE_INSTALL_ROOT: path.join(work, 'install-root'), PYIDE_MC_LAUNCHER: 'off', PYIDE_MC_JAVA: java,
  PYIDE_MC_SOURCES: S({ mojang: `${CLOSED}/manifest.json`, mojangAssets: `${CLOSED}/assets`, paper: `${CLOSED}/paper`, modrinth: `${CLOSED}/modrinth` }),
  PYIDE_MC_SCHEDULE_MS: S({ speed: 20, warn: [20, 10, 5] }) };

const t = await launch({ name: 'craft-schedule', port: 9748, mode: 'craft', lang: 'ko-KR', projectDir: project, env });
const { js, until, check, shot, sleep } = t;
const SEC = `document.querySelector('.custom-tab.mcset:not(.hidden) .mcset-schedule')`;
const srv = `ide.minecraft.servers().find((s) => s.name === 'night')`;
const running = () => js(`ide.minecraft.runningAt(${srv}.dir)`);
const titles = () => js(`ide.notifications.list().map((e) => e.title)`);
// The schedule's own time `minutes` whole minutes from now, as HH:MM, at least 30 of its seconds away.
const timeIn = async (minutes) => {
  const now = (await js(`ide.api.invoke('minecraft:schedule', ide.root, ${srv}.dir)`)).now;
  const d = new Date(now + 30000 + minutes * 60000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const setTasks = (tasks) => js(`ide.api.invoke('minecraft:setSchedule', ide.root, ${srv}.dir, ${S(tasks)})`);
try {
  await until(`!!document.querySelector('#craftHost .mcs-nav')`, 'the craft app', 20000);
  await js(`(() => {
    const invoke = ide.api.invoke;
    ide.api.invoke = (ch, ...a) => ch !== 'minecraft:launch' ? invoke(ch, ...a) : invoke(ch, ...a).then((spec) => ({ ...spec, cmd: ${S(process.execPath)}, args: [${S(standIn)}] }));
    return true;
  })()`);
  await js('ide.minecraft.refresh()');
  await until(`!!${srv}`, 'the server in the list', 10000);

  // ---------- the settings tab's section ----------
  await js(`(ide.minecraft.serverSettings(${srv}), true)`);
  await until(`!!${SEC}`, 'the Schedule section', 10000);
  const first = await js(`(() => { const s = ${SEC}; return { page: [...document.querySelectorAll('.custom-tab.mcset:not(.hidden) .mcset-page')].map((p) => p.textContent).includes('예약'),
    none: s.querySelector('.mcset-schedule-none').textContent, add: s.querySelector('.mcset-schedule-add').textContent, rows: s.querySelectorAll('.mcset-schedule-row').length }; })()`);
  check(first.page && /아직 예약 작업이 없어요/.test(first.none) && first.add === '작업 추가' && first.rows === 0, `the settings tab has a Schedule section in Korean, empty at first (${S(first)})`);
  await js(`(${SEC}.querySelector('.mcset-schedule-add').click(), true)`);
  await until(`${SEC}.querySelector('.mcset-schedule-status').textContent === '저장했어요.'`, 'the new task saved', 5000);
  const added = await js(`(() => { const r = ${SEC}.querySelector('.mcset-schedule-row'); return { time: r.querySelector('.mcset-schedule-time').value, kind: r.querySelector('.mcset-schedule-kind').selectedOptions[0].textContent,
    days: [...r.querySelectorAll('.mcset-schedule-day')].map((d) => d.textContent).join(''), every: r.querySelector('.mcset-schedule-every').textContent, warn: r.querySelector('.mcset-schedule-warn input').checked,
    next: ${SEC}.querySelector('.mcset-schedule-next').textContent }; })()`);
  check(added.time === '04:00' && added.kind === '서버 재시작' && added.days === '일월화수목금토' && added.every === '매일' && added.warn && /서버가 실행 중이고/.test(added.next),
    `Add Task adds a restart at 04:00 every day with the players told, and says the tasks run while the server runs (${S(added)})`);
  check(S(saved()) === S([{ id: 't1', on: true, kind: 'restart', time: '04:00', days: [], warn: true }]), `it is saved at once in the server's file (${S(saved())})`);
  await js(`(${SEC}.scrollIntoView({ block: 'center' }), true)`);
  await shot('schedule-section.png');
  await js(`(() => { const r = ${SEC}.querySelector('.mcset-schedule-row'); r.querySelector('.mcset-schedule-day[data-day="6"]').click(); r.querySelector('.mcset-schedule-day[data-day="0"]').click();
    const k = r.querySelector('.mcset-schedule-kind'); k.value = 'command'; k.dispatchEvent(new Event('change')); return true; })()`);
  await until(`!!${SEC}.querySelector('.mcset-schedule-command')`, 'the command field', 3000);
  check(await js(`${SEC}.querySelector('.mcset-schedule-status').textContent`) === '이 작업이 실행할 명령을 입력하세요.' && saved()[0].kind === 'restart', 'a command task is not saved before it has a command');
  await js(`(() => { const c = ${SEC}.querySelector('.mcset-schedule-command'); c.value = '/say 주말 이벤트'; c.dispatchEvent(new Event('change')); return true; })()`);
  await until(`${SEC}.querySelector('.mcset-schedule-status').textContent === '저장했어요.'`, 'the command task saved', 5000);
  check(S(saved()) === S([{ id: 't1', on: true, kind: 'command', time: '04:00', days: [0, 6], command: 'say 주말 이벤트' }]), `days and the command are saved, the command without its slash (${S(saved())})`);
  await js(`(${SEC}.querySelector('.mcset-schedule-delete').click(), true)`);
  await until(`${SEC}.querySelectorAll('.mcset-schedule-row').length === 0`, 'the row gone', 3000);
  await sleep(300);
  check(S(saved()) === S([]), `Delete removes the task (${S(saved())})`);

  // ---------- a restart and a command of the same minute ----------
  await js(`(ide.minecraft.startServer(${srv}), true)`);
  await until(`ide.minecraft.runningAt(${srv}.dir)`, 'the server running', 20000);
  await sleep(600);
  const when = await timeIn(1);
  const set = await setTasks([{ id: 'night', kind: 'restart', time: when }, { id: 'hello', kind: 'command', time: when, command: 'say scheduled-hello' }]);
  check(set.next?.kind === 'restart' || set.next?.kind === 'command', `with the server running, the next task is known (${S(set.next)})`);
  for (let i = 0; i < 300 && starts() < 2; i++) await sleep(100);
  await until(`ide.minecraft.runningAt(${srv}.dir) && !ide.minecraft.stoppingAt(${srv}.dir)`, 'the server running again', 20000);
  const log = commands();
  const says = log.filter((l) => /^say .*재시작됩니다/.test(l));
  check(starts() === 2, `the server was restarted at its time (${starts()} starts)`);
  check(says.length === 3 && /20초 뒤에/.test(says[0]) && /5초 뒤에/.test(says[2]), `the players were told three times first, in the app's language (${S(says)})`);
  check(log.indexOf('say scheduled-hello') > log.indexOf(says[2]) && log.indexOf('say scheduled-hello') < log.indexOf('stop'), `the command of that minute reached the server before its stop (${S(log)})`);
  const told = await titles();
  check(told.includes('night 서버를 예약대로 재시작했어요') && !told.some((x) => /예기치 않게|unexpectedly/.test(x)), `the owner is told it was the schedule, and it is not reported as a crash (${S(told)})`);
  check(!(await js(`!!document.querySelector('.mc-health-crash, .mc-health.bad')`)), 'the card shows no crash');

  // ---------- Skip This Time ----------
  await sleep(600);
  const before = commands().length;
  await setTasks([{ id: 'bed', kind: 'stop', time: await timeIn(1) }]);
  await until(`ide.notifications.list().some((e) => /^night 서버가 .*에 멈춰요$/.test(e.title))`, 'the notification of the announced stop', 15000);
  const offered = await js(`(() => { const b = [...document.querySelectorAll('.ide-balloon')].find((x) => /에 멈춰요/.test(x.textContent)); const a = [...(b?.querySelectorAll('button, a, .balloon-action') || [])].find((x) => x.textContent.trim() === '이번만 건너뛰기');
    if (!a) return false; a.click(); return true; })()`);
  check(offered, 'the first announcement comes with Skip This Time');
  await sleep(6000); // two of the schedule's minutes: its time has passed
  const after = commands().slice(before);
  check(await running() && !after.includes('stop') && after.some((l) => /^say 종료가 취소되었습니다/.test(l)), `skipped, the server runs on past the time and the players are told it was called off (${S(after)})`);

  // ---------- a stop without announcements ----------
  const mark = commands().length;
  await setTasks([{ id: 'bed', kind: 'stop', time: await timeIn(1), warn: false }]);
  await until(`!ide.minecraft.runningAt(${srv}.dir) && !ide.minecraft.stoppingAt(${srv}.dir)`, 'the server stopped on schedule', 20000);
  const last = commands().slice(mark);
  check(S(last) === S(['stop']) && starts() === 2, `a stop without announcements only stops the server (${S(last)}, ${starts()} starts)`);
  await sleep(800);
  const end = await titles();
  check(end.includes('night 서버를 예약대로 멈췄어요') && !end.some((x) => /예기치 않게/.test(x)), `and says so, not as a crash (${S(end)})`);
  await js(`(ide.minecraft.serverSettings(${srv}), true)`);
  const missing = await js(`(() => { const all = [...(${SEC}?.querySelectorAll('*') || [])].map((n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join('')).filter((x) => /[A-Za-z]{4,}/.test(x) && !/^say /.test(x)); return all; })()`);
  check(!missing.length, `nothing in the section is left in English (${S(missing)})`);
  check(!t.consoleErrors.length, `no renderer exceptions ${S(t.consoleErrors)}`);
} catch (err) {
  check(false, `craft-schedule crashed: ${err.stack || err}`);
}
if (failed) process.exitCode = 1;
console.log(`rules: ${passed}/${passed + failed} passed`);
t.finish();
