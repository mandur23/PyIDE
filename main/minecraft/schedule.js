// A server's scheduled tasks: at a time of day, on the days chosen, restart it, stop it or send it a console command.
// The tasks are the `schedule` list of the server's pyide-server.json; they run while the server runs and the app is
// open, and a time that passed while either was not is skipped, never made up for.
//
//   normalize(list) -> tasks                     what is kept of a list from the window or the file (see TASK below)
//   stepsOf(task, from, proxy) -> [{at, ...}]    the task's next occurrence after `from`, as the steps that make it
//   nextStep(tasks, after, startedAt, skipped, proxy) -> step | null      nextSteps(...) -> every step of that moment
//   createSchedule(deps) -> { of, set, attach, skip, upcoming, shutdown }
//
// A restart or a stop is announced to the players first (say, 5 minutes, 1 minute and 10 seconds before) unless the task
// says not to, and an occurrence counts only when its first announcement comes after the server started: a server
// started at 03:58 is not restarted at 04:00. Main keeps the clock and tells the window what is due
// (`minecraft:schedule` {dir, event: 'due', step}); the window does it, because the window owns the run session (the
// console, Stop with its 60 s of silence, the launch that starts it again).
const TASK_LIMIT = 20;
const COMMAND_LIMIT = 256;
const KINDS = ['restart', 'stop', 'command'];
// A test runs the clock faster and announces closer to the time (PYIDE_MC_SCHEDULE_MS {speed, warn}).
function timing() {
  let t = {};
  try { t = JSON.parse(process.env.PYIDE_MC_SCHEDULE_MS || '{}') || {}; } catch {}
  const warn = Array.isArray(t.warn) && t.warn.length && t.warn.every((s) => Number.isFinite(s) && s > 0) ? [...t.warn].sort((a, b) => b - a) : [300, 60, 10];
  return { warn, speed: Number.isFinite(t.speed) && t.speed >= 1 ? t.speed : 1 };
}
const WARN_SECONDS = timing().warn;
// A step this late is dropped: the computer slept, or the clock was set forward.
const LATE_MS = 90 * 1000;
const RECHECK_MS = 30 * 1000;

const timeOf = (text) => {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(text ?? '').trim());
  return m ? { h: Number(m[1]), m: Number(m[2]), text: `${m[1].padStart(2, '0')}:${m[2]}` } : null;
};

// TASK: { id, on, kind: 'restart' | 'stop' | 'command', time: 'HH:MM' (local), days: [0..6] (Sunday 0; empty = every
// day), warn (restart and stop: announce it first), command (kind command: one console line, without a slash) }.
// Anything else is dropped, and so is a task without a time or a command task without a command.
function normalize(list) {
  const out = [];
  const ids = new Set();
  for (const t of Array.isArray(list) ? list : []) {
    if (out.length >= TASK_LIMIT || !t || typeof t !== 'object') continue;
    const time = timeOf(t.time);
    if (!time || !KINDS.includes(t.kind)) continue;
    const command = t.kind === 'command' ? String(t.command ?? '').replace(/^\s*\/+/, '').trim() : '';
    if (t.kind === 'command' && (!command || command.length > COMMAND_LIMIT || /[\r\n\0]/.test(command))) continue;
    let id = typeof t.id === 'string' && /^[\w-]{1,40}$/.test(t.id) ? t.id : '';
    while (!id || ids.has(id)) id = `t${out.length + 1}${id ? `-${ids.size}` : ''}`;
    ids.add(id);
    const days = [...new Set((Array.isArray(t.days) ? t.days : []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    out.push({ id, on: t.on !== false, kind: t.kind, time: time.text, days: days.length === 7 ? [] : days,
      ...(t.kind === 'command' ? { command } : { warn: t.warn !== false }) });
  }
  return out;
}

// The next time of day `task.time` after `from` on one of its days, in local time (a day's 02:30 that daylight saving
// skips lands where Date puts it).
function occurrence(task, from) {
  const time = timeOf(task.time);
  if (!time) return null;
  const d = new Date(from);
  for (let i = 0; i <= 7; i++) {
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, time.h, time.m, 0, 0);
    if (at.getTime() > from && (!task.days?.length || task.days.includes(at.getDay()))) return at.getTime();
  }
  return null;
}
const leadOf = (task, proxy) => (task.kind !== 'command' && task.warn !== false && !proxy ? WARN_SECONDS[0] * 1000 : 0);

// The steps of the occurrence at `at`: the announcements, then the task itself. A proxy has no `say`.
function stepsAt(task, at, proxy) {
  const steps = [];
  if (leadOf(task, proxy)) for (const s of WARN_SECONDS) steps.push({ at: at - s * 1000, task: task.id, kind: task.kind, occurrence: at, warn: s });
  steps.push({ at, task: task.id, kind: task.kind, occurrence: at, ...(task.kind === 'command' ? { command: task.command } : {}) });
  return steps;
}

// The first step after `after` of any task that is on. An occurrence whose first step is not after `startedAt` is not
// this run's, and one in `skipped` ("<id>@<occurrence>") was called off by the owner.
// Tasks set for the same minute are all due then: nextSteps gives every step of that moment, commands first (a command
// set for the time of a restart reaches the server before its stop).
function nextSteps(tasks, after, startedAt = 0, skipped = new Set(), proxy = false) {
  const firsts = tasks.map((t) => nextStep([t], after, startedAt, skipped, proxy)).filter(Boolean);
  if (!firsts.length) return [];
  const at = Math.min(...firsts.map((x) => x.at));
  return firsts.filter((x) => x.at === at).sort((a, b) => (a.kind === 'command' ? 0 : 1) - (b.kind === 'command' ? 0 : 1));
}
function nextStep(tasks, after, startedAt = 0, skipped = new Set(), proxy = false) {
  let best = null;
  for (const task of tasks) {
    if (!task.on) continue;
    // An occurrence under way (announced, not yet done) started before `after`: look from a lead earlier.
    let from = Math.max(startedAt, after - leadOf(task, proxy)) - 1;
    for (let i = 0; i < 16; i++) {
      const at = occurrence(task, from);
      if (at === null) break;
      from = at;
      if (at - leadOf(task, proxy) <= startedAt || skipped.has(`${task.id}@${at}`)) continue;
      const step = stepsAt(task, at, proxy).find((s) => s.at > after);
      if (step) { if (!best || step.at < best.at) best = step; break; }
    }
  }
  return best;
}

function createSchedule({ send, readServer, writeServer, now: clock = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, speed = timing().speed }) {
  // The schedule's clock: the computer's, or a test's that runs `speed` times as fast from the moment it was made.
  const born = clock();
  const now = () => born + (clock() - born) * speed;
  const wait = (ms) => Math.max(0, ms / speed);
  const keyOf = (dir) => require('path').resolve(dir).toLowerCase();
  const live = new Map(); // key -> {dir, proc, proxy, startedAt, done, timer, skipped}
  const of = (dir) => { try { return normalize(readServer(dir)?.schedule); } catch { return []; } };

  function arm(held) {
    clearTimer(held.timer);
    held.timer = null;
    if (live.get(keyOf(held.dir)) !== held || held.proc.stopAsked) return;
    const steps = nextSteps(of(held.dir), held.done, held.startedAt, held.skipped, held.proxy);
    const step = steps[0];
    if (!step) return;
    const fire = () => {
      if (live.get(keyOf(held.dir)) !== held || held.proc.stopAsked) return;
      const t = now();
      if (t < step.at) { held.timer = setTimer(fire, wait(Math.min(step.at - t, RECHECK_MS))); held.timer?.unref?.(); return; }
      held.done = Math.max(step.at, t - LATE_MS);
      if (t - step.at <= LATE_MS) for (const due of steps) send('minecraft:schedule', { dir: held.dir, event: 'due', step: due });
      arm(held);
    };
    held.timer = setTimer(fire, wait(Math.min(step.at - now(), RECHECK_MS)));
    held.timer?.unref?.();
  }

  // A server process started for dir: its tasks run while it lives and until it is asked to stop.
  function attach(dir, proc, { proxy = false } = {}) {
    const k = keyOf(dir);
    const held = { dir, proc, proxy, startedAt: now(), done: now(), timer: null, skipped: new Set() };
    clearTimer(live.get(k)?.timer);
    live.set(k, held);
    arm(held);
    proc.once?.('stopAsked', () => clearTimer(held.timer));
    proc.once('close', () => {
      clearTimer(held.timer);
      if (live.get(k) === held) live.delete(k);
    });
  }
  function set(dir, list) {
    const tasks = normalize(list);
    const desc = readServer(dir);
    writeServer(dir, { ...desc, schedule: tasks });
    const held = live.get(keyOf(dir));
    if (held) arm(held);
    return tasks;
  }
  // The owner calls one occurrence off (from its first announcement's notification).
  function skip(dir, task, occurrenceAt) {
    const held = live.get(keyOf(dir));
    if (!held) return false;
    held.skipped.add(`${task}@${occurrenceAt}`);
    arm(held);
    return true;
  }
  // What comes next for a running server (the settings tab shows it), or null.
  function upcoming(dir) {
    const held = live.get(keyOf(dir));
    if (!held || held.proc.stopAsked) return null;
    const tasks = of(dir);
    let best = null;
    for (const t of tasks) {
      const step = nextStep([t], held.done, held.startedAt, held.skipped, held.proxy);
      if (step && (!best || step.occurrence < best.occurrence)) best = { task: t.id, kind: t.kind, occurrence: step.occurrence };
    }
    return best;
  }
  function shutdown() {
    for (const held of live.values()) clearTimer(held.timer);
    live.clear();
  }
  return { of, set, attach, skip, upcoming, shutdown, now };
}

module.exports = { normalize, occurrence, stepsAt, nextStep, nextSteps, createSchedule, WARN_SECONDS, LATE_MS, TASK_LIMIT };
