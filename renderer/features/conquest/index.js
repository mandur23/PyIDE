// Nano Studio Conquest, the 1914 grand-strategy game (docs/conquest-architecture.md). This file loads the game's page
// scripts in order: the map view (view/), then the screens listed in ui/modules.json (read through conquest:uiModules;
// a panel added later is a line there), and once the Conquest workspace is open (conquestReady) mounts the shell
// (ui/shell.js) in #conquestHost and shows the start screen (ui/start.js) over the map of the 1914 world.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const log = ide.logger('#conquest');
  const tr = ide.t;
  const VIEW = ['synthetic.js', 'camera.js', 'pick.js', 'raster.js', 'borders.js', 'gl.js', 'units.js', 'labels.js', 'arrows.js', 'view.js'];
  const here = document.currentScript.src.replace(/[^/]*$/, '');
  Conquest.base = here;

  const load = (files) => new Promise((resolve) => {
    let left = files.length;
    if (!left) return resolve();
    const done = () => { if (--left === 0) resolve(); };
    for (const file of files) {
      const script = document.createElement('script');
      script.src = `${here}${file}`;
      script.async = false;
      script.onload = done;
      script.onerror = () => { log.error(`cannot load ${file}`); done(); };
      document.body.appendChild(script);
    }
  });

  Conquest.loaded = (async () => {
    // Feature modules register their IPC after the page is parsed, so the first ask can come before the handler.
    let ui = null;
    for (let i = 0; i < 50 && !ui?.ok; i++) {
      ui = await ide.api.invoke('conquest:uiModules').catch((err) => ({ ok: false, message: err.message, early: /No handler/i.test(err.message) }));
      if (ui.ok || !ui.early) break;
      await new Promise((r) => { setTimeout(r, 100); });
    }
    if (!ui?.ok) log.error(`ui/modules.json: ${ui?.code || ui?.message}`);
    await load([...VIEW.map((f) => `view/${f}`), ...(ui?.ok ? ui.files : []).map((f) => `ui/${f}`)]);
  })();

  ide.on('conquestReady', async ({ host }) => {
    await Conquest.loaded;
    try {
      Conquest.ui.shell.mount(host);
      await Conquest.ui.start.show();
      await Conquest.app.view?.ready;
    } catch (err) {
      log.error(`the map did not start: ${err?.stack || err}`);
      host.replaceChildren(ide.util.el('div', 'cq-error', tr('The map could not start: {message}', { message: String(err?.message || err) })));
    }
  });

  const playing = () => {
    const a = document.activeElement;
    return !!Conquest.app?.view && !(a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)));
  };
  ide.registerAction({ id: 'Conquest.ZoomIn', title: tr('Zoom Map In'), keys: ['PageUp'], when: playing, run: () => Conquest.app.view.zoom(1.4) });
  ide.registerAction({ id: 'Conquest.ZoomOut', title: tr('Zoom Map Out'), keys: ['PageDown'], when: playing, run: () => Conquest.app.view.zoom(1 / 1.4) });
  ide.registerAction({ id: 'Conquest.ShowWholeMap', title: tr('Show Whole Map'), keys: ['Home'], when: playing, run: () => { Conquest.app.view.camera.fit(); Conquest.app.view.redraw(); } });
})();
