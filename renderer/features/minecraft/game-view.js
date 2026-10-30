// Game View: the test client's window while a mod is debugged (Test Client), so a saved change shows in the game next
// to the code. "Beside the IDE" gives the game the right part of the screen and the IDE the rest; "Inside the IDE"
// shows the game's picture in this tool window, the game itself staying behind the IDE (a click on the picture brings
// it to the front to play). Reload Resources sends the game F3+T, Restart debugs the client again (for a change
// HotSwap cannot take), and the last HotSwap result shows below. The window is found by the debug port's JVM
// (main/minecraft/game-window.js).
(() => {
  const { el } = ide.util;
  const mc = ide.minecraft;
  const MODE = 'minecraft.gameView'; // 'beside' | 'inside'
  const ON_TOP = 'minecraft.gameOnTop';
  const mode = () => (ide.settings.get(MODE, 'beside') === 'inside' ? 'inside' : 'beside');
  let client = null; // {dir, con, cfg, port} of the client being debugged (index.js)
  let game = null; // {pid, hwnd, title}: hwnd 0 until the game has a window
  let arranged = 0; // the window last placed or shown, so a window the user moved stays where they put it
  let stream = null;
  let timer = 0;
  let last = null; // the last HotSwap result {ok, error, restart, text}
  let view = null;

  const tw = ide.registerToolWindow({
    id: 'MinecraftGame', title: tr('Game View'), icon: '🎮', iconName: 'gamepad', side: 'right', order: 81,
    mount(container) { view = build(container); render(); },
  });

  function build(container) {
    container.id = 'minecraftGame';
    container.classList.add('mcg');
    const bar = el('div', 'mcg-bar');
    const where = el('select', 'mcg-mode');
    for (const [value, label] of [['beside', tr('Beside the IDE')], ['inside', tr('Inside the IDE')]]) {
      const o = el('option', null, label);
      o.value = value;
      where.append(o);
    }
    where.title = tr('Where the game window goes when the test client starts');
    where.onchange = () => { ide.settings.set(MODE, where.value); arranged = 0; arrange(); };
    const top = el('label', 'mcg-top');
    const topBox = el('input');
    topBox.type = 'checkbox';
    topBox.onchange = () => {
      ide.settings.set(ON_TOP, topBox.checked);
      if (game?.hwnd && mode() === 'beside') ide.api.invoke('minecraft:gameTop', game.hwnd, topBox.checked).catch(() => {});
    };
    top.append(topBox, el('span', null, tr('Always on top')));
    const reload = el('button', 'mcg-reload', tr('Reload Resources'));
    reload.title = tr('Sends F3+T to the game: textures, models, sounds and language files are read again');
    reload.onclick = () => reloadResources();
    const restart = el('button', 'mcg-restart', tr('Restart'));
    restart.title = tr('Stops the test client and debugs it again, for a change HotSwap cannot take');
    restart.onclick = () => { if (client) ide.run.debugConfig(client.cfg); };
    bar.append(where, top, reload, restart);
    const status = el('div', 'mcg-status');
    const screen = el('div', 'mcg-screen');
    const video = el('video');
    video.muted = true;
    video.autoplay = true;
    screen.title = tr('Click to play in the game window');
    screen.onclick = () => { if (game?.hwnd) ide.api.invoke('minecraft:gameFront', game.hwnd).catch(() => {}); };
    screen.append(video);
    const note = el('div', 'mcg-note');
    container.append(bar, status, screen, note);
    return { where, topBox, reload, restart, status, screen, video, note };
  }

  function render() {
    if (!view) return;
    view.where.value = mode();
    view.topBox.checked = !!ide.settings.get(ON_TOP, false);
    view.topBox.parentElement.classList.toggle('hidden', mode() !== 'beside');
    view.reload.disabled = !game?.hwnd;
    view.restart.disabled = !client;
    view.status.textContent = !client ? tr('Start a mod\'s test client (Test Client in the Minecraft window): its game shows here or beside the IDE, and saved code reloads in it.')
      : !game?.hwnd ? tr('Waiting for the game window… The first start downloads Minecraft and takes several minutes.')
        : mode() === 'beside' ? tr('{title} is beside the IDE.', { title: game.title || 'Minecraft' })
          : game.title || 'Minecraft';
    view.screen.classList.toggle('hidden', !(stream && mode() === 'inside'));
    view.note.className = `mcg-note${last ? (last.error ? ' err' : ' ok') : ''}`;
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
      const found = await ide.api.invoke('minecraft:gameFind', game?.pid ? { pid: game.pid } : { port: mine.port });
      if (client !== mine) return;
      if (!found && game?.pid) { game = null; stopStream(); }
      else if (found) {
        const changed = found.hwnd !== game?.hwnd || found.title !== game?.title;
        game = found;
        if (changed) {
          if (game.hwnd && game.hwnd !== arranged) await arrange();
          render();
        }
      }
    } catch (err) {
      if (view) view.status.textContent = mc.errorText(err);
    }
    if (client === mine) timer = setTimeout(poll, game?.hwnd ? 3000 : 1500);
  }

  async function arrange() {
    if (!game?.hwnd) return;
    arranged = game.hwnd;
    try {
      if (mode() === 'beside') {
        stopStream();
        await ide.api.invoke('minecraft:gamePlace', game.hwnd, !!ide.settings.get(ON_TOP, false));
      } else {
        await ide.api.invoke('minecraft:gameTop', game.hwnd, false);
        await startStream();
        tw.show();
      }
    } catch (err) {
      client?.con.append(`${tr('Game View: {error}', { error: mc.errorText(err) })}\n`, 'err');
    }
    render();
  }

  async function startStream() {
    stopStream();
    const source = await ide.api.invoke('minecraft:gameSource', game.hwnd);
    if (!source) throw new Error(tr('The game window cannot be captured'));
    const s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source, maxFrameRate: 30 } } });
    if (!client || mode() !== 'inside') { s.getTracks().forEach((t) => t.stop()); return; }
    stream = s;
    s.getVideoTracks()[0].onended = () => { if (stream === s) { stream = null; render(); } };
    if (view) view.video.srcObject = s;
  }

  function stopStream() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    if (view) view.video.srcObject = null;
  }

  // F3+T in the game (the editor gets the keyboard back): false when there is no game window or it would not come to
  // the front.
  async function reloadResources() {
    if (!game?.hwnd) return false;
    try { return !!(await ide.api.invoke('minecraft:gameReload', game.hwnd)); } catch { return false; }
  }

  ide.on('minecraftClient', (c) => {
    client = c;
    game = null;
    arranged = 0;
    last = null;
    stopStream();
    clearTimeout(timer);
    poll();
    render();
  });
  ide.on('minecraftClientEnded', (c) => {
    if (client !== c) return;
    client = null;
    game = null;
    clearTimeout(timer);
    stopStream();
    render();
    // The game is gone: the right side goes back to the server list.
    if (tw.isVisible()) mc.toolWindow.show();
  });
  ide.on('minecraftHotSwap', (r) => { last = r; render(); });

  mc.game = {
    reloadResources, show: () => tw.show(), toolWindow: tw,
    state: () => ({ client: !!client, game, mode: mode(), streaming: !!stream, note: last?.text || '' }),
  };
})();
