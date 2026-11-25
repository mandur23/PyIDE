// Nano Studio Code's side of the mods and plugins made in Nano Studio Craft (main/minecraft/modmaker.js). Craft's Edit
// in Code opens a mod's or a plugin's folder here; this tells the window what the folder is and where its code starts,
// builds it, and tries it: a mod goes into an instance and the official launcher opens on that instance's profile, a
// plugin (or a mod) goes into a server, which Craft then starts again.
// The test client is the other way to see a mod: the game from the mod's own Gradle (runClient) under Code's Java
// debugger, so a saved change is swapped into the running game (HotSwap) and its window is put beside Code or shown
// inside it (main/minecraft/game-window.js).
//   craft-mods:project(root) -> null | {kind, id, name, loader, api, mc, files, jar, instances, servers, against, fabricApi}
//   craft-mods:build(root, job) -> {jar}
//   craft-mods:send(root, {places, play}, job) -> {added, missing, fabricApi, play}
//       builds, copies the jar into places ([{type, name}]), then opens the launcher on the instance named by play
//   craft-mods:newInstance(root, title, job) -> an instance of the mod's loader and Minecraft version
//   craft-mods:cancel(job)
//   craft-mods:client(root, port, job) -> {procId, sourceRoots}     gradlew runClient, its JVM waiting on the debug port
//   craft-mods:hotswapCompile(root, files, job) -> [{name, file}]   the saved .java files, for the debugger to redefine
//   craft-mods:hotswapResources(root, files) -> {copied, assets, data}
//   craft-mods:gameFind({port} | {pid}), gamePlace(hwnd, top), gameTop(hwnd, top), gameFront(hwnd), gameReload(hwnd),
//   gameSource(hwnd) -> the window's capture source for the Game View's video
//   craft-mods:log {job, text} -> the window, while a job runs
// The Craft folder is the one the mod lies in (<craft folder>/mods/<id>, <craft folder>/plugins/<Name>).
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const trust = require('../trust');
const { allowWindowCapture } = require('../security');
const gameWindow = require('../minecraft/game-window');

const fail = (message, code) => Object.assign(new Error(message), { expected: true, code });
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// Craft's main module is loaded when a mod's folder is first asked about and not at start: most of Code's projects
// are no mods. Its register() is Craft's alone, so nothing of its window or its servers runs here.
let craftSide = null;
const craft = () => (craftSide ||= require('./minecraft'));

// The folder as Craft's mod or plugin: {home, item, ref}, or null for any other folder.
function locate(root) {
  if (typeof root !== 'string' || !root) return null;
  const dir = path.resolve(root);
  const group = path.basename(path.dirname(dir)).toLowerCase();
  // Most folders stop here, before any of Craft's code is loaded.
  if (group !== 'mods' && group !== 'plugins') return null;
  const { MOD, PLUGIN } = require('../minecraft/modmaker');
  if (!isFile(path.join(dir, group === 'mods' ? MOD : PLUGIN))) return null;
  const home = path.dirname(path.dirname(dir));
  const kind = group === 'mods' ? 'mod' : 'plugin';
  const item = craft().modMaker.list(home).find((m) => m.kind === kind && m.id.toLowerCase() === path.basename(dir).toLowerCase());
  return item ? { home, item, ref: kind === 'plugin' ? { plugin: item.id } : { id: item.id } } : null;
}

// The files a newcomer is shown, each with what it is: [{role, path, dir?}].
function guideFiles(item) {
  const at = (...rel) => path.join(item.dir, ...rel);
  const first = (...files) => files.find(isFile) || null;
  const out = [];
  if (item.main) out.push({ role: 'main', path: item.main });
  if (item.kind === 'mod' && item.main) {
    // Fabric's example mod keeps what only the player's game runs in its own source set.
    const name = `${path.basename(item.main, '.java')}Client.java`;
    const walk = (d) => {
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch {}
      for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        const found = e.isDirectory() ? walk(path.join(d, e.name)) : e.name === name ? path.join(d, e.name) : null;
        if (found) return found;
      }
      return null;
    };
    const client = walk(at('src', 'client', 'java')) || walk(at('src', 'main', 'java'));
    if (client) out.push({ role: 'client', path: client });
  }
  const meta = first(at('src', 'main', 'resources', 'fabric.mod.json'), at('src', 'main', 'templates', 'META-INF', 'neoforge.mods.toml'),
    at('src', 'main', 'resources', 'META-INF', 'neoforge.mods.toml'), at('src', 'main', 'resources', 'META-INF', 'mods.toml'),
    at('src', 'main', 'resources', 'plugin.yml'), at('src', 'main', 'resources', 'velocity-plugin.json'));
  if (meta) out.push({ role: 'meta', path: meta });
  if (isDir(at('src', 'main', 'resources'))) out.push({ role: 'resources', path: at('src', 'main', 'resources'), dir: true });
  if (item.kind === 'mod' && isFile(at('gradle.properties'))) out.push({ role: 'properties', path: at('gradle.properties') });
  return out;
}

function describe(root) {
  const found = locate(root);
  if (!found) return null;
  const { home, item, ref } = found;
  const { modMaker } = craft();
  const { list } = modMaker.targets(home, ref);
  const place = ({ type, name, title, mc, loader }) => ({ type, name, title, mc, loader });
  return {
    kind: item.kind, id: item.id, name: item.name, loader: item.loader || null, api: item.api || null, mc: item.mc, dir: item.dir,
    files: guideFiles(item), jar: item.jar ? { name: item.jar.name, time: item.jar.time } : null,
    // A mod is tried where Minecraft is its own version; a plugin's API says nothing of the version.
    instances: list.filter((t) => t.type === 'instance' && t.sameMc).map(place),
    servers: list.filter((t) => t.type === 'server' && t.sameMc).map(place),
    against: item.against || null,
    fabricApi: item.kind === 'mod' && item.loader === 'fabric' ? modMaker.fabricApiOf(item.dir) : null,
  };
}

module.exports = {
  register({ ipcMain, send, startProcess }) {
    const guard = (root) => { if (!root || !trust.isTrusted(root)) throw fail('The project is open in Safe Mode, where Nano Studio runs nothing from it', 'untrusted'); };
    const need = (root) => {
      guard(root);
      const found = locate(root);
      if (!found) throw fail('This folder is not a mod or a plugin made in Nano Studio Craft', 'noMod');
      return found;
    };
    const running = new Map(); // job -> AbortController
    const cancellable = async (job, step) => {
      const ctl = new AbortController();
      running.set(job, ctl);
      const log = Object.assign((text) => send('craft-mods:log', { job, text: String(text) }), { signal: ctl.signal });
      try { return await step(log); } catch (err) {
        throw ctl.signal.aborted ? fail('Cancelled', 'cancelled') : err;
      } finally { running.delete(job); }
    };
    const placesOf = (list) => (Array.isArray(list) ? list : []).filter((p) => (p?.type === 'instance' || p?.type === 'server') && typeof p.name === 'string').map(({ type, name }) => ({ type, name }));

    // A folder open in Safe Mode is no mod here: describing one reads the craft folder around it (its instances, its
    // servers, the jars in them), which an untrusted folder must not point this program at.
    ipcMain.handle('craft-mods:project', (_e, root) => {
      if (!root || !trust.isTrusted(root)) return null;
      try { return describe(root); } catch { return null; }
    });
    ipcMain.handle('craft-mods:build', (_e, root, job) => {
      const { home, ref } = need(root);
      return cancellable(job, (log) => craft().modMaker.build(home, ref, log));
    });
    ipcMain.handle('craft-mods:send', (_e, root, opts, job) => {
      const { home, ref, item } = need(root);
      const places = placesOf(opts?.places);
      const play = typeof opts?.play === 'string' && places.some((p) => p.type === 'instance' && p.name === opts.play) ? opts.play : null;
      if (!places.length) throw fail('Choose where the file goes');
      return cancellable(job, async (log) => {
        const { modMaker, launcher } = craft();
        await modMaker.build(home, ref, log);
        log.signal.throwIfAborted();
        const added = modMaker.addTo(home, ref, places);
        for (const a of added) log(a.ok ? `Added ${a.file} to ${a.title}\n` : `${a.error}\n`);
        if (!play || added.some((a) => !a.ok)) return { added, missing: [], fabricApi: null, play: null };
        // What the mod cannot start without: Fabric API is fetched, the version the mod is built with; the rest is said.
        const at = { type: 'instance', name: play };
        let missing = modMaker.missingIn(home, ref, at);
        let fabricApi = null;
        if (item.loader === 'fabric' && missing.some((id) => id === 'fabric-api' || id === 'fabric')) {
          try {
            fabricApi = await modMaker.addFabricApi(home, ref, at, log);
            log(`Added ${fabricApi.file} to the instance: the mod needs Fabric API\n`);
            missing = modMaker.missingIn(home, ref, at);
          } catch (err) {
            if (log.signal.aborted) throw err;
            log(`Fabric API could not be added: ${err.message}\n`);
          }
        }
        log.signal.throwIfAborted();
        return { added, missing, fabricApi, play: await launcher.play(home, play, {}, log) };
      });
    });
    ipcMain.handle('craft-mods:newInstance', (_e, root, title, job) => {
      const { home, item } = need(root);
      if (item.kind !== 'mod') throw fail('A plugin is tried on a server, not in an instance');
      return cancellable(job, (log) => craft().launcher.create(home, { name: String(title || `${item.name} test`), mc: item.mc, loader: item.loader }, log));
    });
    ipcMain.handle('craft-mods:cancel', (_e, job) => { running.get(job)?.abort(); return true; });
    // ---------- the test client ----------
    const needMod = (root) => {
      const found = need(root);
      if (found.item.kind !== 'mod') throw fail('A plugin has no test client: it is tried on a server');
      return found;
    };
    ipcMain.handle('craft-mods:client', (_e, root, port, job) => {
      const { home, ref } = needMod(root);
      return cancellable(job, async (log) => {
        const spec = await craft().modMaker.clientTask(home, ref, { debugPort: port }, log);
        log.signal.throwIfAborted();
        return { procId: startProcess(spec.cmd, spec.args, { cwd: spec.cwd, env: spec.env, windowsHide: true }), sourceRoots: spec.sourceRoots };
      });
    });
    ipcMain.handle('craft-mods:hotswapCompile', (_e, root, files, job) => {
      const { home, ref } = needMod(root);
      return cancellable(job, (log) => craft().modMaker.hotswapCompile(home, ref, files, log));
    });
    ipcMain.handle('craft-mods:hotswapResources', (_e, root, files) => {
      const { home, ref } = needMod(root);
      return craft().modMaker.hotswapResources(home, ref, files);
    });
    // The game's window: found by the JVM on the debug port (then by its process), placed beside the window that
    // asks, kept on top, brought to the front, sent F3+T; gameSource names it for the Game View's video and opens the
    // few seconds in which the page may capture it (main/security.js).
    ipcMain.handle('craft-mods:gameFind', (_e, q) => gameWindow.find(q || {}));
    ipcMain.handle('craft-mods:gamePlace', (e, hwnd, top) => gameWindow.placeBeside(BrowserWindow.fromWebContents(e.sender), screen, hwnd, top));
    ipcMain.handle('craft-mods:gameTop', (_e, hwnd, top) => gameWindow.setTop(hwnd, top));
    ipcMain.handle('craft-mods:gameFront', (_e, hwnd) => gameWindow.front(hwnd));
    ipcMain.handle('craft-mods:gameReload', (_e, hwnd) => gameWindow.reload(hwnd));
    ipcMain.handle('craft-mods:gameSource', async (_e, hwnd) => {
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find((x) => x.id.startsWith(`window:${Number(hwnd)}:`));
      if (!source) return null;
      allowWindowCapture();
      return source.id;
    });
    // A build's Gradle outlives this program unless its process tree is ended; so does the window helper.
    app.on('will-quit', () => { craftSide?.modMaker.stop(); gameWindow.stop(); });
  },
};
