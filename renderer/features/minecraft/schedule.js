// A server's scheduled tasks (main/minecraft/schedule.js keeps the clock and says what is due: minecraft:schedule): at
// a time of day, on the days chosen, restart the server, stop it or send it a console command. This window does the
// step, as the owner would: the announcement is a `say` typed into the console, a restart is the card's Restart (Stop
// with its save, then the launch), and the first announcement comes with a notification that can call this one time off.
// The settings tab's "Schedule" section lists the tasks; a change is saved at once, without Save.
(() => {
  const { el } = ide.util;
  const mc = ide.minecraft;
  const keyOf = (dir) => dir.toLowerCase();
  const serverAt = (dir) => mc.servers().find((s) => keyOf(s.dir) === keyOf(dir)) || null;
  const notify = (o) => ide.notifications?.notify({ group: 'Minecraft', raw: true, ...o });
  const sessionAt = (dir) => ide.run.sessions().find((x) => x.cfg?.type === 'minecraft-server' && keyOf(ide.run.resolvePath(x.cfg.dir)) === keyOf(dir));
  const notices = new Map(); // "<dir>|<task>@<occurrence>" -> the notification of an announced restart or stop
  const listeners = new Set(); // open settings sections, told when something ran

  const KIND = () => ({ restart: tr('Restart the server'), stop: tr('Stop the server'), command: tr('Run a command') });
  const DAYS = () => [tr('Sun'), tr('Mon'), tr('Tue'), tr('Wed'), tr('Thu'), tr('Fri'), tr('Sat')];
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // "in 5 minutes", "in 1 minute", "in 10 seconds"
  const within = (seconds) => (seconds >= 120 ? tr('in {n} minutes', { n: Math.round(seconds / 60) }) : seconds >= 60 ? tr('in 1 minute') : tr('in {n} seconds', { n: seconds }));

  // ---------- what is due ----------
  ide.api.on('minecraft:schedule', (e) => {
    if (e.event !== 'due' || !e.step) return;
    const { dir, step } = e;
    const srv = serverAt(dir);
    const name = srv?.name || dir.split(/[\\/]/).pop();
    if (!mc.runningAt(dir) || mc.stoppingAt(dir)) return;
    const id = `${keyOf(dir)}|${step.task}@${step.occurrence}`;
    if (step.warn) {
      const when = within(step.warn);
      mc.sendCommand(dir, `say ${step.kind === 'restart' ? tr('The server restarts {when}.', { when }) : tr('The server stops {when}.', { when })}`);
      if (!notices.has(id)) {
        notices.set(id, notify({
          title: step.kind === 'restart' ? tr('{name} restarts at {time}', { name, time: clock(step.occurrence) }) : tr('{name} stops at {time}', { name, time: clock(step.occurrence) }),
          text: tr('A scheduled task. The players are told 5 minutes, 1 minute and 10 seconds before.'), kind: 'info', timeout: 0,
          actions: [{ label: tr('Skip This Time'), run: async (n) => {
            n.expire();
            notices.delete(id);
            const skipped = await ide.api.invoke('minecraft:skipSchedule', ide.root, dir, step.task, step.occurrence).catch(() => false);
            if (skipped) mc.sendCommand(dir, `say ${step.kind === 'restart' ? tr('The restart was called off.') : tr('The stop was called off.')}`);
            for (const f of listeners) f(dir);
          } }],
        }));
      }
      return;
    }
    notices.get(id)?.expire?.();
    notices.delete(id);
    if (step.kind === 'command') {
      mc.sendCommand(dir, step.command);
    } else if (step.kind === 'stop') {
      notify({ title: tr('{name} stopped on schedule', { name }), kind: 'info' });
      sessionAt(dir)?.stop();
    } else {
      notify({ title: tr('{name} restarted on schedule', { name }), kind: 'info' });
      mc.health?.restart(dir);
    }
    setTimeout(() => { for (const f of listeners) f(dir); }, 500);
  });

  // ---------- the settings tab's section ----------
  function settingsControl(srv) {
    const box = el('div', 'mcset-schedule');
    const rows = el('div', 'mcset-schedule-list');
    const status = el('div', 'mcset-desc muted mcset-schedule-status');
    const next = el('div', 'mcset-desc mcset-schedule-next');
    const add = el('button', 'secondary mcset-schedule-add', tr('Add Task'));
    let tasks = [];
    let turn = 0;

    const paintNext = (n) => {
      if (!tasks.some((t) => t.on)) next.textContent = '';
      else if (!mc.runningAt(srv.dir)) next.textContent = tr('The tasks run while the server runs and Nano Studio is open. A time that passes meanwhile is skipped.');
      else if (n) next.textContent = tr('Next: {what} at {when}', { what: KIND()[n.kind], when: new Date(n.occurrence).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) });
      else next.textContent = '';
    };
    async function save() {
      const mine = ++turn;
      try {
        const r = await ide.api.invoke('minecraft:setSchedule', ide.root, srv.dir, tasks);
        if (mine !== turn) return;
        status.textContent = tr('Saved.');
        paintNext(r.next);
      } catch (err) { if (mine === turn) status.textContent = mc.errorText(err); }
    }
    // A save still on its way would answer "Saved." over this.
    const askCommand = () => { turn++; status.textContent = tr('Type the command this task runs.'); };
    function line(t) {
      const r = el('div', 'mcset-schedule-row');
      r.dataset.task = t.id;
      const sw = el('label', 'mcset-switch');
      const on = el('input');
      on.type = 'checkbox';
      on.checked = t.on;
      on.title = tr('On');
      on.onchange = () => { t.on = on.checked; save(); };
      sw.append(on, el('span', 'mcset-knob'));
      const time = el('input', 'input mcset-schedule-time');
      time.type = 'time';
      time.value = t.time;
      time.onchange = () => { if (time.value) { t.time = time.value; save(); } else time.value = t.time; };
      const kind = el('select', 'input mcset-schedule-kind');
      for (const [k, label] of Object.entries(KIND())) kind.add(new Option(label, k));
      kind.value = t.kind;
      const days = el('div', 'mcset-schedule-days');
      days.title = tr('No day chosen means every day.');
      DAYS().forEach((label, d) => {
        const b = el('button', `mcset-schedule-day${t.days.includes(d) ? ' on' : ''}`, label);
        b.type = 'button';
        b.dataset.day = d;
        b.onclick = () => {
          t.days = t.days.includes(d) ? t.days.filter((x) => x !== d) : [...t.days, d].sort();
          if (t.days.length === 7) t.days = [];
          for (const x of days.children) x.classList.toggle('on', t.days.includes(Number(x.dataset.day)));
          every.classList.toggle('hidden', t.days.length > 0);
          save();
        };
        days.append(b);
      });
      const every = el('span', `muted mcset-schedule-every${t.days.length ? ' hidden' : ''}`, tr('Every day'));
      const extra = el('div', 'mcset-schedule-extra');
      const paintExtra = () => {
        extra.replaceChildren();
        if (t.kind === 'command') {
          const c = el('input', 'input mcset-schedule-command');
          c.placeholder = tr('A console command, for example: say Hello');
          c.value = t.command || '';
          c.maxLength = 256;
          c.spellcheck = false;
          // A task without a command is not kept, so it is saved once there is one.
          c.onchange = () => { t.command = c.value.replace(/^\s*\/+/, '').trim(); c.value = t.command; if (t.command) save(); else askCommand(); };
          extra.append(c);
        } else {
          const l = el('label', 'mcset-schedule-warn');
          const w = el('input');
          w.type = 'checkbox';
          w.checked = t.warn !== false;
          w.onchange = () => { t.warn = w.checked; save(); };
          l.append(w, el('span', '', tr('Tell the players 5 minutes, 1 minute and 10 seconds before')));
          extra.append(l);
        }
      };
      kind.onchange = () => {
        t.kind = kind.value;
        if (t.kind === 'command') delete t.warn; else { delete t.command; t.warn = true; }
        paintExtra();
        if (t.kind !== 'command') save(); else askCommand();
      };
      paintExtra();
      const del = el('button', 'secondary mcset-schedule-delete', tr('Delete'));
      del.type = 'button';
      del.onclick = () => { tasks = tasks.filter((x) => x !== t); r.remove(); empty(); save(); };
      const top = el('div', 'mcset-schedule-top');
      top.append(sw, time, kind, days, every, del);
      r.append(top, extra);
      return r;
    }
    const none = el('div', 'muted mcset-schedule-none', tr('No tasks yet. Add one to restart the server every night, or to run a command at a set time.'));
    const empty = () => none.classList.toggle('hidden', tasks.length > 0);
    const paint = () => { rows.replaceChildren(...tasks.map(line)); empty(); };
    add.onclick = () => {
      if (tasks.length >= 20) { status.textContent = tr('A server has 20 tasks at most.'); return; }
      const ids = new Set(tasks.map((t) => t.id));
      let n = tasks.length + 1;
      while (ids.has(`t${n}`)) n++;
      const t = { id: `t${n}`, on: true, kind: 'restart', time: '04:00', days: [], warn: true };
      tasks.push(t);
      rows.append(line(t));
      empty();
      save();
    };
    const load = () => ide.api.invoke('minecraft:schedule', ide.root, srv.dir).then((r) => {
      if (!box.isConnected && tasks.length) return;
      tasks = r.tasks;
      paint();
      paintNext(r.next);
    }, () => {});
    const heard = (dir) => {
      if (!box.isConnected) { listeners.delete(heard); return; }
      if (keyOf(dir) === keyOf(srv.dir)) ide.api.invoke('minecraft:schedule', ide.root, srv.dir).then((r) => paintNext(r.next), () => {});
    };
    listeners.add(heard);
    box.append(rows, none, add, next, status);
    empty();
    load();
    return box;
  }

  mc.schedule = { settingsControl };
})();
