// The test client of the mod open in Code, and its Game View (main/features/craft-mods.js, main/minecraft/game-window.js).
// - Test Client debugs `gradlew runClient`: the mod's development game starts under Code's Java debugger (breakpoints in
//   the mod stop it), found by the JVM on the debug port.
// - HotSwap: while it runs, a saved .java file of the mod is compiled and its classes are redefined in the game. The JVM
//   swaps what is inside methods only: a new method or field, or a changed signature, needs a restart, which is said
//   with the reason. A saved file under assets/ is copied to the game's resources and the game reloads them (F3+T);
//   data/ waits for /reload in the game.
// - Game View, the box at the top of the Minecraft tool window while the client runs: "Beside Code" gives the game the
//   right part of the screen and Code the rest; "Inside Code" shows the game's picture in the box, the game itself
//   staying behind (a click on the picture brings it to the front to play). Reload Resources sends the game F3+T,
//   Restart debugs the client again, Stop ends it, and the last HotSwap result shows below.
(() => {
  const { el, basename } = ide.util;
  const cm = ide.craftMods;
  const MODE = 'craftMods.gameView'; // 'beside' | 'inside'
  const ON_TOP = 'craftMods.gameOnTop';
  const mode = () => (ide.settings.get(MODE, 'beside') === 'inside' ? 'inside' : 'beside');
  let client = null; // {root, con, port} of the client being debugged
  let game = null; // {pid, hwnd, title}: hwnd 0 until the game has a window
  let arranged = 0; // the window last placed or shown, so a window the user moved stays where they put it
  let stream = null;
  let pictures = 0; // how many times the game's picture started
  let lost = false; // the picture ended by itself
  let timer = 0;
  let last = null; // the last HotSwap result {ok, error, restart, text}
  let view = null;

  const available = () => !!ide.debugger?.debugJvm;
  const running = () => !!client;

  // ---------- the client ----------
  function start() {
    const p = cm.state().project;
    if (!p || p.kind !== 'mod' || !available() || !cm.trusted()) return null;
    const root = ide.root;
    let mine = null;
    return ide.debugger.debugJvm({
      rerun: start,
      async launch({ con, port }) {
        const job = cm.job(con);
        try {
          const r = await ide.api.invoke('craft-mods:client', root, port, job.id);
          con.append(`gradlew runClient (${tr('debug port {port}', { port })})\n`, 'sys');
          began(mine = { root, con, port });
          // Gradle prepares Minecraft before the game starts: the first time, many minutes.
          return { procId: r.procId, sourceRoots: r.sourceRoots, timeoutMs: 30 * 60000 };
        } catch (err) {
          con.append(`${cm.errorText(err)}\n`, 'err');
          return null;
        } finally { job.done(); }
      },
    }).then((handle) => {
      handle?.ended?.then(() => { if (mine) ended(mine); });
      return handle;
    });
  }
  function began(c) {
    client = c;
    game = null;
    arranged = 0;
    last = null;
    stopStream();
    clearTimeout(timer);
    poll();
    render();
    cm.render();
  }
  function ended(c) {
    if (client !== c) return;
    client = null;
    game = null;
    clearTimeout(timer);
    stopStream();
    render();
    cm.render();
  }

  // ---------- HotSwap ----------
  let pending = new Set();
  let pendingResources = new Set();
  let swapping = null;
  let swapTimer = 0;
  let resourceTimer = 0;
  const said = (r) => { last = r; render(); };
  ide.on('fileSaved', (tab) => {
    const p = tab?.path;
    if (!client || !p || !p.toLowerCase().startsWith(`${client.root.toLowerCase()}\\`)) return;
    if (/\.java$/i.test(p)) {
      pending.add(p);
      clearTimeout(swapTimer);
      swapTimer = setTimeout(swap, 300);
    } else if (/^\\src\\[^\\]+\\resources\\(assets|data)\\/i.test(p.slice(client.root.length))) {
      pendingResources.add(p);
      clearTimeout(resourceTimer);
      resourceTimer = setTimeout(swapResources, 300);
    }
  });
  async function swapResources() {
    const files = [...pendingResources];
    pendingResources = new Set();
    if (!files.length || !client) return;
    const { root, con } = client;
    try {
      const r = await ide.api.invoke('craft-mods:hotswapResources', root, files);
      if (!r.copied.length) return;
      con.append(`${tr('Resources copied to the game: {files}', { files: r.copied.join(', ') })}\n`, 'sys');
      if (r.assets) {
        const reloaded = await reloadResources();
        const text = reloaded ? tr('The game reloads its resources (F3+T).') : tr('Press F3+T in the game to see the new resources.');
        con.append(`${text}\n`, reloaded ? 'ok' : 'sys');
        said({ ok: !!reloaded, text });
      }
      if (r.data) {
        const text = tr('Type /reload in the game to apply the changed data (recipes, loot tables, tags).');
        con.append(`${text}\n`, 'sys');
        said({ ok: true, text });
      }
    } catch (err) {
      con.append(`${tr('HotSwap failed: {error}', { error: cm.errorText(err) })}\n`, 'err');
    }
  }
  async function swap() {
    if (swapping) { await swapping; return swap(); }
    const files = [...pending];
    pending = new Set();
    if (!files.length || !client) return;
    const { root, con } = client;
    swapping = (async () => {
      const job = cm.job(con);
      const started = Date.now();
      try {
        con.append(`${tr('HotSwap: compiling {files}…', { files: files.map((f) => basename(f)).join(', ') })}\n`, 'sys');
        const classes = await ide.api.invoke('craft-mods:hotswapCompile', root, files, job.id);
        const r = await ide.debugger.jvmRequest('redefineClasses', { classes });
        const done = tr('HotSwap: {count} classes reloaded in the game ({ms} ms)', { count: r.redefined.length, ms: Date.now() - started });
        con.append(`${done}${r.redefined.length ? `: ${r.redefined.join(', ')}` : ''}\n`, 'ok');
        said({ ok: true, text: done });
      } catch (err) {
        const text = cm.errorText(err);
        // JDWP's errors 60 to 72: the class cannot be redefined as it is now.
        const restart = /JDWP error (6\d|7\d)/.test(text);
        const line = restart ? tr('HotSwap: the game cannot take this change without a restart ({reason}). Press Restart.', { reason: text.replace(/^.*\(([^)]*)\)\s*$/, (_m, why) => why) })
          : /does not compile/.test(text) ? tr('HotSwap: the saved code does not compile. The lines above say where.')
            : tr('HotSwap failed: {error}', { error: text });
        con.append(`${line}\n`, 'err');
        said({ restart, error: true, text: line });
      } finally { job.done(); }
    })();
    await swapping;
    swapping = null;
  }

  // ---------- the Game View ----------
  function build(box) {
    const head = el('div', 'cmod-game-head');
    head.append(ide.icon('gamepad'), el('span', 'cmod-step-title', tr('Game View')));
    const bar = el('div', 'cmod-game-bar');
    const where = el('select', 'input cmod-select cmod-game-mode');
    for (const [value, label] of [['beside', tr('Beside Code')], ['inside', tr('Inside Code')]]) where.add(new Option(label, value));
    where.title = tr('Where the game window goes when the test client starts');
    where.onchange = () => { ide.settings.set(MODE, where.value); arranged = 0; arrange(); };
    const top = el('label', 'cmod-game-top');
    const topBox = el('input');
    topBox.type = 'checkbox';
    topBox.onchange = () => {
      ide.settings.set(ON_TOP, topBox.checked);
      if (game?.hwnd && mode() === 'beside') ide.api.invoke('craft-mods:gameTop', game.hwnd, topBox.checked).catch(() => {});
    };
    top.append(topBox, el('span', null, tr('Always on top')));
    const button = (label, cls, title, run) => { const b = el('button', `cmod-btn ${cls}`, label); b.title = title; b.onclick = run; return b; };
    const reload = button(tr('Reload Resources'), 'cmod-game-reload', tr('Sends F3+T to the game: textures, models, sounds and language files are read again'), () => reloadResources());
    const restart = button(tr('Restart Game'), 'cmod-game-restart', tr('Stops the test client and starts it again, for a change HotSwap cannot take'), () => start());
    const stop = button(tr('Stop Game'), 'cmod-game-stop', tr('Ends the test client'), () => ide.runAction('StopDebug'));
    const buttons = el('div', 'cmod-game-buttons');
    buttons.append(reload, restart, stop);
    bar.append(where, top);
    const status = el('div', 'cmod-game-status muted');
    const screen = el('div', 'cmod-game-screen hidden');
    const video = el('video');
    video.muted = true;
    video.autoplay = true;
    screen.title = tr('Click to play in the game window');
    screen.onclick = () => { if (game?.hwnd) ide.api.invoke('craft-mods:gameFront', game.hwnd).catch(() => {}); };
    screen.append(video);
    const note = el('div', 'cmod-game-note');
    box.append(head, bar, buttons, status, screen, note);
    return { box, where, topBox, reload, restart, status, screen, video, note };
  }
  function render() {
    const box = cm.gameBox();
    if (!box) return;
    if (!view) view = build(box);
    box.classList.toggle('hidden', !client);
    view.where.value = mode();
    view.topBox.checked = !!ide.settings.get(ON_TOP, false);
    view.topBox.parentElement.classList.toggle('hidden', mode() !== 'beside');
    view.reload.disabled = !game?.hwnd;
    view.status.textContent = !client ? ''
      : !game?.hwnd ? tr('Waiting for the game window… The first start downloads Minecraft and takes several minutes.')
        : mode() === 'beside' ? tr('{title} is beside Code.', { title: game.title || 'Minecraft' })
          : lost ? tr('The picture of the game window stopped. The game still runs: choose Beside Code to see it.')
            : game.title || 'Minecraft';
    view.screen.classList.toggle('hidden', !(stream && mode() === 'inside'));
    view.note.className = `cmod-game-note${last ? (last.error ? ' err' : ' ok') : ''}`;
    view.note.textContent = last?.text || '';
    view.restart.classList.toggle('primary', !!last?.restart);
  }

  // The client's JVM is found by its debug port as soon as it waits for the debugger, then followed by its process:
  // its window appears when Minecraft has loaded, and is placed or shown once.
  async function poll() {
    timer = 0;
    const mine = client;
    if (!mine) return;
    try {
      const found = await ide.api.invoke('craft-mods:gameFind', game?.pid ? { pid: game.pid } : { port: mine.port });
      if (client !== mine) return;
      if (!found && game?.pid) { game = null; stopStream(); render(); }
      else if (found) {
        const changed = found.hwnd !== game?.hwnd || found.title !== game?.title;
        game = found;
        if (changed) {
          if (game.hwnd && game.hwnd !== arranged) await arrange();
          render();
        }
      }
    } catch (err) {
      if (view) view.status.textContent = cm.errorText(err);
    }
    if (client === mine) timer = setTimeout(poll, game?.hwnd ? 3000 : 1500);
  }
  async function arrange() {
    if (!game?.hwnd) return;
    arranged = game.hwnd;
    try {
      if (mode() === 'beside') {
        stopStream();
        await ide.api.invoke('craft-mods:gamePlace', game.hwnd, !!ide.settings.get(ON_TOP, false));
      } else {
        await ide.api.invoke('craft-mods:gameTop', game.hwnd, false);
        await startStream();
        cm.show();
      }
    } catch (err) {
      client?.con.append(`${tr('Game View: {error}', { error: cm.errorText(err) })}\n`, 'err');
    }
    render();
  }
  async function startStream() {
    stopStream();
    const source = await ide.api.invoke('craft-mods:gameSource', game.hwnd);
    if (!source) throw new Error(tr('The game window cannot be captured'));
    const s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source, maxFrameRate: 30 } } });
    if (!client || mode() !== 'inside') { s.getTracks().forEach((t) => t.stop()); return; }
    stream = s;
    pictures++;
    // Windows ends the capture of a window it cannot draw from (one on another desktop, one that was destroyed): the
    // box says so instead of going blank without a word.
    s.getVideoTracks()[0].onended = () => { if (stream === s) { stream = null; lost = true; render(); } };
    if (view) view.video.srcObject = s;
  }
  function stopStream() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    lost = false;
    if (view) view.video.srcObject = null;
  }
  // F3+T in the game (the editor gets the keyboard back): false when there is no game window or it would not come to
  // the front.
  async function reloadResources() {
    if (!game?.hwnd) return false;
    try { return !!(await ide.api.invoke('craft-mods:gameReload', game.hwnd)); } catch { return false; }
  }

  cm.game = { available, running, start, reloadResources,
    state: () => ({ client: !!client, game, mode: mode(), streaming: !!stream, pictures, lost, note: last?.text || '', restart: !!last?.restart }) };
  render();
  cm.render();
})();
