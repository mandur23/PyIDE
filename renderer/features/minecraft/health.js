// A server that ended without being asked, froze or cannot keep up (main/minecraft/health-monitor.js tells this window:
// minecraft:health). The card says what the evidence says and offers what the owner can do: Restart, the crash report
// or log, the fix when it is a setting, a backup's restore. With the server's automatic restart on, a crash restarts
// after the wait main names, and a loop stops with the reason; lag is never acted on by itself. The settings tab's
// "Crashes and Lag" section holds the three switches and the numbers behind the card's state.
(() => {
  const { el } = ide.util;
  const mc = ide.minecraft;
  const views = new Map(); // folder (lower case) -> {report, frozen, load, restartAt, restartTimer, applied, hidden}
  const keyOf = (dir) => dir.toLowerCase();
  const viewOf = (dir) => { const k = keyOf(dir); if (!views.has(k)) views.set(k, {}); return views.get(k); };
  const serverAt = (dir) => mc.servers().find((s) => keyOf(s.dir) === keyOf(dir)) || null;
  const render = () => mc.render?.();
  const notify = (o) => ide.notifications?.notify({ group: 'Minecraft', raw: true, ...o });
  const gb = (mb) => Math.round(mb / 1024);
  const seconds = (ms) => Math.max(0, Math.round(ms / 1000));

  // A list that comes from main after a reload says what this window has not heard. Each list is taken in once: the
  // events since then are newer than it.
  function seed(srv) {
    const v = viewOf(srv.dir);
    const h = srv.health;
    if (!h || v.seeded === h) return v;
    v.seeded = h;
    // A list read before the server started again still carries the end before it.
    if (h.report && (!v.report || h.report.at > v.report.at) && !v.dismissedAt?.[h.report.at] && !(h.report.at < v.startedAt)) v.report = h.report;
    if (!h.report && v.report && !v.restartTimer) v.report = null;
    v.frozen = h.frozen;
    if (h.load) v.load = h.load;
    v.settings = h.settings;
    return v;
  }

  ide.api.on('minecraft:health', (e) => {
    const v = viewOf(e.dir);
    const srv = serverAt(e.dir);
    const name = srv?.name || e.dir.split(/[\\/]/).pop();
    if (e.event === 'started') {
      v.report = null; v.frozen = false; v.load = null; v.hidden = null;
      v.startedAt = Date.now();
      cancelRestart(v);
    } else if (e.event === 'stopped') {
      v.frozen = false; v.load = null;
    } else if (e.event === 'crashed') {
      v.report = e.report; v.frozen = false; v.load = null;
      crashed(e.dir, name, e.report);
    } else if (e.event === 'frozen') {
      v.frozen = true;
      frozen(e.dir, name, e);
    } else if (e.event === 'recovered') {
      v.frozen = false;
    } else if (e.event === 'load') {
      const was = v.load?.state;
      v.load = e;
      if (e.state === 'fine') v.hidden = null;
      if (e.notify && (srv?.health?.settings?.overload ?? true)) overloaded(e.dir, name, e);
      // The state's numbers change every half minute; the card is drawn again only when what it shows changes.
      if (was === e.state) { paintChip(e.dir); return; }
    }
    render();
  });

  // ---------- what a cause means ----------
  // -> {title, text, fix, actions: [{label, cls, run}]}: the words for a report, and what can be done about it.
  function explain(dir, r) {
    const f = r.facts || {};
    const ram = f.ramMB ? gb(f.ramMB) : null;
    const items = (f.items || []).map((d) => (d.found ? tr('{mod} needs {needs} ({version}), but {found} is there', d) : tr('{mod} needs {needs} ({version}), which is missing', d)));
    const settings = { label: tr('Settings…'), cls: 'mc-health-settings', run: () => { const s = serverAt(dir); if (s) mc.serverSettings(s); } };
    const folder = { label: tr('Open Folder'), cls: 'mc-health-folder', run: () => ide.api.invoke('shell:openPath', dir) };
    const memoryTo = (to) => ({ label: tr('Set Memory to {memory}', { memory: to }), cls: 'mc-health-fix', run: () => applyMemory(dir, f.memory, to, true) });
    switch (r.cause) {
      case 'memory': return {
        title: tr('It ran out of memory'),
        text: tr('The server used all the memory it may take ({memory}) and stopped. This PC has {ram} GB.', { memory: f.memory, ram }),
        fix: f.suggested ? tr('Give it more: {memory} leaves room for Windows and, if you play here, the game. It applies at the next start.', { memory: f.suggested })
          : tr('This PC has no room to give it more. Close other programs, or remove some mods or plugins.'),
        actions: f.suggested ? [memoryTo(f.suggested)] : [],
      };
      case 'memoryTooHigh': return {
        title: tr('Its memory is set higher than this PC can give'),
        text: tr('Java could not reserve the {memory} the server is set to take. This PC has {ram} GB.', { memory: f.memory, ram }),
        fix: f.suggested ? tr('Lower it to {memory}. It applies at the next start.', { memory: f.suggested }) : tr('Lower the memory in Settings.'),
        actions: f.suggested ? [memoryTo(f.suggested)] : [settings],
      };
      case 'pcMemory': return {
        title: tr('The PC ran out of memory'),
        text: tr('Windows could not give Java more memory: the server and other programs used up this PC\'s {ram} GB. Giving the server more memory would make this worse.', { ram }),
        fix: tr('Close other programs, or lower the server\'s memory in Settings.'), actions: [settings],
      };
      case 'port': return {
        title: tr('Its port is already in use'),
        text: tr('Another program, or another server, already uses port {port}, so this one could not open it.', { port: f.port ?? '' }),
        fix: tr('Stop that program, or give this server another port in Settings.'), actions: [settings],
      };
      case 'dependency': return {
        title: f.gameVersion ? tr('A mod is made for another version') : tr('A mod is missing what it needs'),
        text: items.join('\n'),
        fix: f.gameVersion ? tr('Install the mod\'s version for this server\'s Minecraft and loader, or remove it from the mods folder.')
          : tr('Install what it names (the Market finds most mods), or remove the mod from the mods folder.'),
        actions: [...(serverAt(dir)?.mods ? [{ label: tr('Market'), cls: 'mc-health-market', run: () => ide.minecraft.market.open({ type: 'mod', server: serverAt(dir) }) }] : []), folder],
      };
      case 'java': return {
        title: tr('It needs another Java version'),
        text: f.has ? tr('The server needs Java {needs}, but it ran on Java {has}.', f) : tr('The server needs Java {needs}.', f),
        fix: tr('In pyide-server.json, set "java" to {needs}: the next start uses that Java and downloads it if it is missing.', f),
        actions: [{ label: tr('Open pyide-server.json'), cls: 'mc-health-open', run: () => ide.openFile(`${dir}\\pyide-server.json`) }],
      };
      case 'world': return {
        title: tr('The world could not be loaded'),
        text: tr('The server says its world files may be damaged (level.dat or the region files).'),
        fix: mc.backups?.open ? tr('Restore the world from a backup.') : tr('Put back a copy of the world folder if you have one.'),
        actions: mc.backups?.open ? [] : [folder],
      };
      case 'eula': return {
        title: tr('The Minecraft EULA is not accepted'),
        text: tr('eula.txt does not say eula=true, so the server does not start. Nano Studio never accepts it for you.'),
        fix: tr('Read the Minecraft EULA. If you agree, change eula=false to eula=true in eula.txt yourself.'),
        actions: [{ label: tr('Open eula.txt'), cls: 'mc-health-open', run: () => ide.openFile(`${dir}\\eula.txt`) },
          { label: tr('Minecraft EULA'), cls: 'mc-health-eula', run: () => ide.api.invoke('shell:openExternal', 'https://aka.ms/MinecraftEULA') }],
      };
      case 'watchdog': return {
        title: tr('It froze, and its watchdog stopped it'),
        text: f.seconds ? tr('One tick took {seconds} seconds, so the server took itself for crashed and stopped.', f) : tr('The server stopped answering, took itself for crashed and stopped.'),
        fix: tr('A heavy farm, a large explosion or a plugin often does this. The crash report shows what the server was doing.'), actions: [],
      };
      case 'startup': return {
        title: tr('It failed to start'),
        text: tr('The server stopped while starting. Its own words are below.'), fix: '', actions: [],
      };
      default: return {
        title: tr('It stopped unexpectedly'),
        text: r.whileAway && !r.lines.length ? tr('It ended while Nano Studio was not running, or the PC was shut down, and left no error behind.')
          : r.lines.length ? tr('Nano Studio cannot tell why. These are its last error lines.') : tr('Nano Studio cannot tell why: it printed no error.'),
        fix: '', actions: [],
      };
    }
  }
  const evidenceActions = (r) => [
    ...(r.files?.crash ? [{ label: tr('Open Crash Report'), cls: 'mc-health-report', run: () => ide.openFile(r.files.crash) }] : []),
    ...(r.files?.hsErr ? [{ label: tr('Open Java Error Log'), cls: 'mc-health-hserr', run: () => ide.openFile(r.files.hsErr) }] : []),
    ...(!r.files?.crash && r.files?.log ? [{ label: tr('Open Log'), cls: 'mc-health-log', run: () => ide.openFile(r.files.log) }] : []),
  ];
  const restartLine = (r, auto) => {
    const x = r.restart || {};
    if (x.restart) return null; // the countdown says it
    if (x.why === 'loop') return tr('It stopped {count} times in 10 minutes, so automatic restart has stopped. Fix the cause first.', { count: x.count });
    if (!auto) return null;
    if (x.why === 'cause') return tr('Not restarted automatically: this would happen again at every start.');
    if (x.why === 'startup') return tr('Not restarted automatically: it stopped before it had finished starting, and would again.');
    return null;
  };

  // ---------- events ----------
  function crashed(dir, name, r) {
    const v = viewOf(dir);
    const ex = explain(dir, r);
    const auto = serverAt(dir)?.health?.settings?.autoRestart;
    const restarting = r.restart?.restart;
    const text = [ex.text, ex.fix, restartLine(r, auto), restarting ? tr('Restarting it automatically in {seconds} s ({count} of 3 in 10 minutes).', { seconds: seconds(r.restart.delayMs), count: r.restart.count }) : '']
      .filter(Boolean).join('\n');
    v.notice?.expire?.();
    v.notice = notify({
      title: r.cause === 'unknown' ? (r.whileAway ? tr('{name} ended while Nano Studio was not running', { name }) : tr('{name} stopped unexpectedly', { name }))
        : r.whileAway ? tr('{name} ended while Nano Studio was not running: {title}', { name, title: ex.title }) : tr('{name} stopped unexpectedly: {title}', { name, title: ex.title }),
      text, kind: 'error', timeout: 0,
      actions: [
        ...(restarting ? [] : [{ label: tr('Restart'), run: (n) => { n.expire(); restart(dir); } }]),
        ...ex.actions.filter((a) => a.cls === 'mc-health-fix').map((a) => ({ label: a.label, run: (n) => { n.expire(); a.run(); } })),
        ...evidenceActions(r).slice(0, 1).map((a) => ({ label: a.label, run: () => a.run() })),
      ],
    });
    if (restarting) scheduleRestart(dir, name, r.restart);
  }
  function scheduleRestart(dir, name, x) {
    const v = viewOf(dir);
    cancelRestart(v);
    v.restartAt = Date.now() + x.delayMs;
    v.restartCount = x.count;
    v.restartTimer = setTimeout(async () => {
      v.restartTimer = null;
      v.restartAt = null;
      const srv = serverAt(dir);
      if (!srv || mc.runningAt(dir) || mc.stoppingAt(dir)) { render(); return; }
      notify({ title: tr('{name} restarted automatically', { name }), text: tr('This is restart {count} of 3 in 10 minutes. The card says why it stopped.', { count: x.count }), kind: 'warn' });
      await mc.startServer(srv);
    }, x.delayMs);
    v.tick = setInterval(() => paintCountdown(dir), 1000);
  }
  function cancelRestart(v) {
    clearTimeout(v.restartTimer);
    clearInterval(v.tick);
    v.restartTimer = null;
    v.restartAt = null;
  }
  function frozen(dir, name, e) {
    const x = e.restart;
    const quiet = Math.round(e.quietMs / 60000) || 1;
    const auto = x?.restart;
    notify({
      title: tr('{name} is not responding', { name }), kind: 'error', timeout: 0,
      text: [tr('It has printed nothing and answered no status request for {minutes} min, though its process still runs. It may be stuck in a long save or out of memory.', { minutes: quiet }),
        auto ? tr('Restarting it now ({count} of 3 in 10 minutes): Stop asks it to save first, and ends it if it stays silent for 60 seconds.', { count: x.count })
          : x?.why === 'loop' ? tr('It stopped {count} times in 10 minutes, so automatic restart has stopped. Fix the cause first.', { count: x.count })
            : tr('Restart asks it to save first, and ends it if it stays silent for 60 seconds.')].join('\n'),
      actions: auto ? [] : [{ label: tr('Restart'), run: (n) => { n.expire(); restart(dir); } }],
    });
    if (auto) restart(dir);
  }
  function overloaded(dir, name, e) {
    const tip = e.suggestions[0];
    notify({
      title: tr('{name} cannot keep up', { name }), kind: 'warn',
      text: [numbersText(e.numbers).join('\n'), tip ? tipText(tip) : tr('Nano Studio has no change to suggest from what the server reports.')].filter(Boolean).join('\n'),
      actions: [...(tip && tipLabel(tip) ? [{ label: tipLabel(tip), run: (n) => { n.expire(); applyTip(dir, tip); } }] : []),
        { label: tr('Settings…'), run: (n) => { n.expire(); const s = serverAt(dir); if (s) mc.serverSettings(s); } }],
    });
  }

  // ---------- actions ----------
  // A running server (a frozen one) gets the normal Stop first, with its forced end after 60 s of silence.
  async function restart(dir) {
    const srv = serverAt(dir);
    if (!srv) return;
    const s = ide.run.sessions().find((x) => x.cfg?.type === 'minecraft-server' && keyOf(ide.run.resolvePath(x.cfg.dir)) === keyOf(dir));
    if (!s?.running) { cancelRestart(viewOf(dir)); await mc.startServer(srv); return; }
    s.con?.append(`${tr('Restarting the server…')}\n`, 'sys');
    const ended = new Promise((resolve) => { s.exitHooks.push(resolve); });
    s.stop();
    await ended;
    await ide.run.runConfig(s.cfg, { confirm: false, remember: false });
  }
  async function save(dir, values) {
    try { await ide.api.invoke('minecraft:saveSettings', ide.root, dir, values); return true; } catch (err) { ide.ui.alert(mc.errorText(err)); return false; }
  }
  async function applyMemory(dir, from, to, startAfter) {
    if (!(await save(dir, { memory: to }))) return;
    viewOf(dir).applied = { what: tr('Memory {from} → {to}', { from, to }), undo: { memory: from } };
    await mc.refresh();
    if (startAfter && !mc.runningAt(dir)) notify({ title: tr('Memory set to {memory}', { memory: to }), text: tr('It applies when the server starts.'), kind: 'ok',
      actions: [{ label: tr('Start'), run: (n) => { n.expire(); restart(dir); } }, { label: tr('Undo Change'), run: (n) => { n.expire(); undo(dir); } }] });
  }
  async function applyTip(dir, tip) {
    const v = viewOf(dir);
    if (tip.id === 'memory') return applyMemory(dir, tip.from, tip.to, false);
    if (tip.id === 'antiXray') { const s = serverAt(dir); if (s) mc.serverSettings(s); return undefined; }
    if (tip.id !== 'distance') return undefined;
    if (!(await save(dir, { props: { 'view-distance': String(tip.view.to), 'simulation-distance': String(tip.sim.to) } }))) return undefined;
    v.applied = { what: tr('View distance {vf} → {vt}, simulation distance {sf} → {st}', { vf: tip.view.from, vt: tip.view.to, sf: tip.sim.from, st: tip.sim.to }),
      undo: { props: { 'view-distance': String(tip.view.from), 'simulation-distance': String(tip.sim.from) } } };
    render();
    return undefined;
  }
  async function undo(dir) {
    const v = viewOf(dir);
    if (!v.applied || !(await save(dir, v.applied.undo))) return;
    v.applied = null;
    await mc.refresh();
  }

  // ---------- words for the numbers ----------
  function numbersText(n) {
    if (!n) return [];
    return [
      n.tps !== null && n.tps !== undefined ? tr('TPS {tps} over the last minute (20 is full speed)', { tps: n.tps }) : '',
      n.behindCount ? tr('{count} "Can\'t keep up" warnings in 5 minutes, at most {seconds} s behind', { count: n.behindCount, seconds: (n.behindMaxMs / 1000).toFixed(1) }) : '',
      n.heapPct !== null && n.heapPct !== undefined ? tr('Memory left in use after GC: {used} of {max} MB ({pct}%)', { used: n.heapAfterMB, max: n.xmxMB, pct: n.heapPct }) : '',
      n.gcPauseMs ? tr('GC pauses in the last minute: {seconds} s', { seconds: (n.gcPauseMs / 1000).toFixed(1) }) : '',
      n.fullGcs ? tr('Full GCs in 5 minutes: {count}', { count: n.fullGcs }) : '',
      n.cpu !== null && n.cpu !== undefined ? tr('CPU: {pct}% of the whole PC', { pct: n.cpu }) : '',
      n.workingSetMB ? tr('Process memory: {mb} MB', { mb: n.workingSetMB }) : '',
    ].filter(Boolean);
  }
  const tipLabel = (tip) => ({
    memory: () => tr('Set Memory to {memory}', { memory: tip.to }),
    distance: () => tr('Lower View and Simulation Distance'),
    antiXray: () => tr('Open Anti-Xray Settings'),
  })[tip.id]?.() || null;
  const tipText = (tip) => ({
    memory: () => tr('Memory is nearly full after each GC and the pauses are long: memory {from} → {to}, at the next start. You can undo it.', tip),
    noRoom: () => tr('Memory is nearly full after each GC, and this PC has no room to give it more than {memory}. Remove some mods or plugins, or close other programs.', tip),
    distance: () => tr('Ticks fall behind while memory is fine: view distance {vf} → {vt}, simulation distance {sf} → {st}, at the next start. You can undo it.', { vf: tip.view.from, vt: tip.view.to, sf: tip.sim.from, st: tip.sim.to }),
    antiXray: () => tr('Anti-xray is on Strong, which costs CPU on every chunk sent. Basic is much lighter.'),
  })[tip.id]?.() || '';
  const STATE = () => ({ fine: tr('Smooth'), lagging: tr('Lagging'), overloaded: tr('Overloaded') });

  // ---------- the card ----------
  function chip(srv) {
    const v = seed(srv);
    if (!mc.runningAt(srv.dir) || !v.load || v.frozen) {
      return v.frozen && mc.runningAt(srv.dir) ? Object.assign(el('span', 'mcc-chip bad mc-load-chip frozen', tr('Not responding')), { title: tr('No output and no answer to a status request for 2 minutes') }) : null;
    }
    const c = el('span', `mcc-chip mc-load-chip ${v.load.state}`, STATE()[v.load.state]);
    c.dataset.dir = srv.dir;
    c.title = numbersText(v.load.numbers).join('\n') || tr('No numbers yet');
    return c;
  }
  function paintChip(dir) {
    const v = viewOf(dir);
    for (const c of document.querySelectorAll('.mc-load-chip')) if (c.dataset.dir && keyOf(c.dataset.dir) === keyOf(dir)) c.title = numbersText(v.load?.numbers).join('\n') || tr('No numbers yet');
    for (const t of document.querySelectorAll('.mcset-health-numbers')) if (keyOf(t.dataset.dir || '') === keyOf(dir)) t.textContent = numbersBlock(dir);
  }
  function paintCountdown(dir) {
    const v = viewOf(dir);
    for (const t of document.querySelectorAll('.mc-health-count')) {
      if (keyOf(t.dataset.dir) !== keyOf(dir)) continue;
      t.textContent = tr('Restarting it automatically in {seconds} s ({count} of 3 in 10 minutes).', { seconds: seconds(v.restartAt - Date.now()), count: v.restartCount });
    }
    if (!v.restartAt) clearInterval(v.tick);
  }
  const btn = (a) => {
    const b = el('button', `secondary ${a.cls || ''}`, a.label);
    b.onclick = (e) => { e.preventDefault(); a.run(); };
    return b;
  };
  // The panels under a card's buttons: why it ended, a freeze, an overload.
  function panels(srv) {
    const v = seed(srv);
    const out = [];
    const running = mc.runningAt(srv.dir);
    if (v.report && !running) out.push(crashPanel(srv, v));
    if (v.frozen && running) {
      const p = el('div', 'mc-health bad mc-health-frozen');
      p.append(el('div', 'mc-health-title', tr('Not responding')),
        el('div', 'mc-health-text', tr('No output and no answer to a status request for 2 minutes, though its process still runs.')));
      const row = el('div', 'mc-health-actions');
      row.append(btn({ label: tr('Restart'), cls: 'mc-health-restart', run: () => restart(srv.dir) }));
      p.append(row);
      out.push(p);
    }
    if (running && v.load?.state === 'overloaded' && v.hidden !== 'load') out.push(loadPanel(srv, v));
    else if (v.applied && running) out.push(appliedPanel(srv, v));
    return out;
  }
  function crashPanel(srv, v) {
    const r = v.report;
    const ex = explain(srv.dir, r);
    const p = el('div', 'mc-health bad mc-health-crash');
    p.dataset.cause = r.cause;
    // An unknown cause has no title of its own: the heading is the event.
    p.append(el('div', 'mc-health-title', r.cause === 'unknown' ? (r.whileAway ? tr('Ended while Nano Studio was not running') : ex.title)
      : r.whileAway ? tr('Ended while Nano Studio was not running: {title}', { title: ex.title }) : tr('Stopped unexpectedly: {title}', { title: ex.title })));
    if (ex.text) p.append(el('div', 'mc-health-text', ex.text));
    if (ex.fix) p.append(el('div', 'mc-health-fix-text', ex.fix));
    const auto = srv.health?.settings?.autoRestart;
    const line = restartLine(r, auto);
    if (line) p.append(el('div', 'mc-health-note', line));
    if (v.restartAt) {
      const c = el('div', 'mc-health-note mc-health-count', '');
      c.dataset.dir = srv.dir;
      p.append(c);
      setTimeout(() => paintCountdown(srv.dir), 0);
    }
    if (r.lines?.length) {
      const d = el('details', 'mc-health-lines');
      d.append(el('summary', null, tr('What it said ({count} lines)', { count: r.lines.length })));
      const pre = el('pre', 'mc-health-pre', r.lines.join('\n'));
      pre.dataset.userText = '';
      d.append(pre);
      p.append(d);
    }
    if (r.code !== null && r.code !== undefined) p.append(el('div', 'mc-health-note muted', tr('Exit code {code}', { code: r.code })));
    const row = el('div', 'mc-health-actions');
    if (v.restartAt) row.append(btn({ label: tr('Cancel Restart'), cls: 'mc-health-cancel', run: () => { cancelRestart(v); render(); } }));
    else row.append(btn({ label: tr('Restart'), cls: 'mc-health-restart', run: () => restart(srv.dir) }));
    for (const a of [...ex.actions, ...evidenceActions(r)]) row.append(btn(a));
    // The server's Backups tab (backups.js), where Restore… is.
    if (mc.backups?.open && ['world', 'unknown', 'watchdog'].includes(r.cause)) row.append(btn({ label: tr('Restore a Backup…'), cls: 'mc-health-restore', run: () => mc.backups.open(srv) }));
    row.append(btn({ label: tr('Close'), cls: 'mc-health-dismiss', run: () => dismiss(srv.dir) }));
    p.append(row);
    return p;
  }
  function loadPanel(srv, v) {
    const p = el('div', 'mc-health warn mc-health-load');
    p.append(el('div', 'mc-health-title', tr('It cannot keep up')));
    const nums = numbersText(v.load.numbers);
    if (nums.length) p.append(el('div', 'mc-health-text', nums.join('\n')));
    const tips = v.load.suggestions || [];
    if (!tips.length) p.append(el('div', 'mc-health-fix-text', tr('Nano Studio has no change to suggest from what the server reports.')));
    const row = el('div', 'mc-health-actions');
    for (const tip of tips) {
      p.append(el('div', 'mc-health-fix-text', tipText(tip)));
      if (tipLabel(tip)) row.append(btn({ label: tipLabel(tip), cls: `mc-health-tip mc-health-tip-${tip.id}`, run: () => applyTip(srv.dir, tip) }));
    }
    row.append(btn({ label: tr('Hide'), cls: 'mc-health-dismiss', run: () => { v.hidden = 'load'; render(); } }));
    p.append(row);
    if (v.applied) p.append(appliedPanel(srv, v));
    return p;
  }
  function appliedPanel(srv, v) {
    const p = el('div', 'mc-health ok mc-health-applied');
    p.append(el('div', 'mc-health-text', tr('Saved: {what}. It applies when the server starts again.', { what: v.applied.what })));
    const row = el('div', 'mc-health-actions');
    row.append(btn({ label: tr('Restart Now'), cls: 'mc-health-restart', run: () => { v.applied = null; v.hidden = 'load'; restart(srv.dir); } }),
      btn({ label: tr('Undo Change'), cls: 'mc-health-undo', run: () => undo(srv.dir) }));
    p.append(row);
    return p;
  }
  async function dismiss(dir) {
    const v = viewOf(dir);
    cancelRestart(v);
    (v.dismissedAt ||= {})[v.report?.at] = true;
    v.report = null;
    await ide.api.invoke('minecraft:dismissHealth', ide.root, dir).catch(() => {});
    render();
  }

  // ---------- the settings tab ----------
  function numbersBlock(dir) {
    const v = viewOf(dir);
    if (!mc.runningAt(dir)) return tr('The numbers show while the server runs.');
    if (!v.load) return tr('Measuring… the first numbers come half a minute after the server has started.');
    return [`${tr('State')}: ${STATE()[v.load.state]}`, ...numbersText(v.load.numbers)].join('\n');
  }
  function settingsControl(srv) {
    const box = el('div', 'mcset-health');
    const rows = [
      ['autoRestart', tr('Restart after a crash'), tr('Waits 10 s, then 30 s; stops after 3 crashes in 10 minutes, and never restarts after a cause that would come back (memory, port, a missing mod, Java, the world).')],
      ['hang', tr('Tell me when it stops responding'), tr('No output and no answer to a status request for 2 minutes, counted from when it has finished starting.')],
      ['overload', tr('Tell me when it cannot keep up'), tr('Once per episode, when it lasts a minute or more. Nothing is changed for you.')],
    ];
    const status = el('div', 'mcset-desc muted mcset-health-status');
    let current = { autoRestart: false, hang: true, overload: true, ...(srv.health?.settings || {}) };
    for (const [key, label, desc] of rows) {
      const line = el('label', 'mcset-health-row');
      const c = el('input');
      c.type = 'checkbox';
      c.checked = !!current[key];
      c.dataset.health = key;
      c.onchange = async () => {
        try {
          current = await ide.api.invoke('minecraft:setHealth', ide.root, srv.dir, { [key]: c.checked });
          status.textContent = tr('Saved.');
          mc.refresh();
        } catch (err) { c.checked = !c.checked; status.textContent = mc.errorText(err); }
      };
      const text = el('div', 'mcset-text');
      text.append(el('div', 'mcset-label', label), el('div', 'mcset-desc muted', desc));
      const sw = el('span', 'mcset-switch');
      sw.append(c, el('span', 'mcset-knob'));
      line.append(sw, text);
      box.append(line);
    }
    const nums = el('pre', 'mcset-health-numbers', numbersBlock(srv.dir));
    nums.dataset.dir = srv.dir;
    box.append(status, el('div', 'mcset-label', tr('Now')), nums);
    // The tab may have been opened from a list older than the last change.
    ide.api.invoke('minecraft:healthOf', ide.root, srv.dir).then((h) => {
      current = h.settings;
      for (const c of box.querySelectorAll('input[data-health]')) c.checked = !!current[c.dataset.health];
    }, () => {});
    return box;
  }

  mc.health = { chip, panels, settingsControl, restart, explain };
})();
