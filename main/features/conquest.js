// Main side of Nano Studio Conquest (renderer/features/conquest, mode 'conquest'; docs/conquest-architecture.md).
// The page cannot read files (CSP: no fetch) and starts workers only from blob: URLs, so it gets here the simulation's
// source text, its static data files and its save files. Saves live in <home>\Saves, home being the Conquest workspace
// (PYIDE_CONQUEST_HOME for tests). Every answer is a value ({ok: true, ...} or {ok: false, code}), never a throw.
// A save's first field is the page's meta ({"meta":{...},"format":...}, sim/host.js), which conquest:list reads from
// the head of each file. Closing the window with a game running first asks the page for an autosave
// (conquest:quitSave, answered by conquest:quitSaved, at most QUIT_SAVE_MS), and the quit gate waits for the write.
// Each game autosaves to its own "Autosave <game>" file; after one is written only the newest AUTOSAVE_KEEP autosaves
// stay. conquest:testHooks tells the page whether PYIDE_CONQUEST_TEST=1 allows the worker's test message.
const fs = require('fs');
const os = require('os');
const path = require('path');

const FEATURE_DIR = path.join(__dirname, '..', '..', 'renderer', 'features', 'conquest');
const SIM_DIR = path.join(FEATURE_DIR, 'sim');
const DATA_DIR = path.join(FEATURE_DIR, 'data');
const SAVE_EXT = '.ncq';
const SAVE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _.()-]{0,79}$/u;
const MAX_SAVE_BYTES = 64 * 1024 * 1024;
const META_BYTES = 16384;
const QUIT_SAVE_MS = 10000;
const UI_DIR = path.join(FEATURE_DIR, 'ui');
const AUTOSAVE = /^Autosave( .+)?\.ncq$/;
const AUTOSAVE_KEEP = 5;

const conquestHome = () => path.resolve(process.env.PYIDE_CONQUEST_HOME || path.join(os.homedir(), 'Nano Studio Conquest'));
const inside = (dir, file) => {
  const rel = path.relative(dir, file);
  return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
const failure = (err) => ({ ok: false, code: err?.code === 'ENOENT' ? 'missing' : 'unreadable', message: String(err?.message || err) });

// A relative path under `dir` from the page: forward slashes, no drive, no '..', and the real file still inside.
async function realUnder(dir, rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 200 || /[:\\]|(^|\/)\.\.?(\/|$)/.test(rel)) return null;
  const full = path.join(dir, ...rel.split('/'));
  if (!inside(dir, full)) return null;
  const [real, base] = await Promise.all([fs.promises.realpath(full), fs.promises.realpath(dir)]);
  return inside(base, real) ? real : null;
}

// The files of sim/modules.json joined in their order: a list of paths relative to sim/, or {files: [...]}.
async function workerSource() {
  let list;
  try {
    const json = JSON.parse(await fs.promises.readFile(path.join(SIM_DIR, 'modules.json'), 'utf8'));
    list = Array.isArray(json) ? json : json?.files;
  } catch (err) {
    return err instanceof SyntaxError ? { ok: false, code: 'invalid', message: err.message } : failure(err);
  }
  if (!Array.isArray(list) || !list.length || !list.every((f) => typeof f === 'string')) return { ok: false, code: 'invalid', message: 'modules.json lists no files' };
  const parts = [];
  for (const rel of list) {
    let file = null;
    try { file = await realUnder(SIM_DIR, rel); } catch (err) { return { ...failure(err), file: rel }; }
    if (!file) return { ok: false, code: 'invalid', message: `not a file under sim/: ${rel}`, file: rel };
    try { parts.push(`// ---- sim/${rel}\n${await fs.promises.readFile(file, 'utf8')}`); } catch (err) { return { ...failure(err), file: rel }; }
  }
  return { ok: true, text: parts.join('\n;\n'), files: list };
}

// The meta object at the start of a save, or null: '{"meta":' then the object up to ',"format":'.
async function readMeta(file) {
  let fh = null;
  try {
    fh = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(META_BYTES);
    const { bytesRead } = await fh.read(buf, 0, META_BYTES, 0);
    const head = buf.subarray(0, bytesRead).toString('utf8');
    if (!head.startsWith('{"meta":')) return null;
    const end = head.indexOf(',"format":"nano-conquest-save"');
    if (end < 0) return null;
    const meta = JSON.parse(head.slice(8, end));
    return meta && typeof meta === 'object' ? meta : null;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function uiModules() {
  try {
    const list = JSON.parse(await fs.promises.readFile(path.join(UI_DIR, 'modules.json'), 'utf8'));
    if (!Array.isArray(list) || !list.every((f) => typeof f === 'string' && /^[\w-]+\.js$/.test(f))) return { ok: false, code: 'invalid' };
    return { ok: true, files: list };
  } catch (err) {
    return err instanceof SyntaxError ? { ok: false, code: 'invalid', message: err.message } : failure(err);
  }
}

async function readData(rel) {
  if (typeof rel !== 'string' || !rel.endsWith('.json')) return { ok: false, code: 'invalid' };
  try {
    const file = await realUnder(DATA_DIR, rel);
    if (!file) return { ok: false, code: 'invalid' };
    return { ok: true, text: await fs.promises.readFile(file, 'utf8') };
  } catch (err) {
    return failure(err);
  }
}

// The optional wording of a diplomatic reply (plan decision 5, setting conquest.llmReplies, off by default): Claude
// (main/ai/claude.js, the user's own Claude Code sign-in) rewrites the one canned reply the screen shows, in the
// voice of that nation in its year. It gets only the nation's name, the year, the decision, its main factors as plain
// words and the canned sentence; the decision itself is made by the simulation. Any failure or WORDING_MS without an
// answer is { ok: false, code } and the screen keeps the canned line. PYIDE_CONQUEST_WORDING_MS shortens the wait in
// tests, which point PYIDE_CLAUDE_PATH at a stand-in.
const WORDING_MS = 20000;
const WORDING_SYSTEM = `You write one diplomatic reply for a grand-strategy game set in the First World War.
The reply speaks as the government of the named nation in the given year, addressed to the nation that made the offer.
Keep the decision and its reasons exactly as given; do not add facts, events, people or promises.
Write exactly two sentences in the requested language, plain text, no quotation marks, no greeting or signature.`;
const clip = (x, n) => String(x ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n);

function wordingPrompt(p) {
  const factors = (Array.isArray(p.factors) ? p.factors : []).slice(0, 3).map((x) => `- ${clip(x, 120)}`).join('\n');
  return [
    `Nation: ${clip(p.nation, 60)}`,
    `Year: ${Number.isInteger(p.year) ? p.year : 1914}`,
    `Decision: ${clip(p.decision, 80)}`,
    `Main reasons:\n${factors || '- none given'}`,
    `Plain reply: ${clip(p.canned, 400)}`,
    `Language: ${p.language === 'Korean' ? 'Korean (formal written style, ending sentences in -습니다)' : 'English'}`,
  ].join('\n');
}

async function wording(p, { complete = require('../ai/claude').complete, ms = Number(process.env.PYIDE_CONQUEST_WORDING_MS) || WORDING_MS } = {}) {
  if (!p || typeof p !== 'object' || !clip(p.canned, 400) || !clip(p.nation, 60)) return { ok: false, code: 'invalid' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await complete({ system: WORDING_SYSTEM, prompt: wordingPrompt(p), signal: ac.signal });
    const text = clip(r?.text, 600);
    return text ? { ok: true, text } : { ok: false, code: 'empty' };
  } catch (err) {
    return { ok: false, code: ac.signal.aborted ? 'timeout' : err?.code || 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

function register({ ipcMain, diagnostics, getWindow, holdQuit }) {
  const log = diagnostics?.logger?.('#conquest');
  const saves = () => path.join(conquestHome(), 'Saves');
  const saveFile = (name) => (typeof name === 'string' && SAVE_NAME.test(name) && !/\.$/.test(name) ? path.join(saves(), `${name}${SAVE_EXT}`) : null);

  ipcMain.handle('conquest:workerSource', () => workerSource());
  ipcMain.handle('conquest:data', (e, rel) => readData(rel));
  ipcMain.handle('conquest:uiModules', () => uiModules());
  ipcMain.handle('conquest:wording', (e, p) => wording(p));
  ipcMain.handle('conquest:testHooks', () => ({ ok: true, on: process.env.PYIDE_CONQUEST_TEST === '1' }));

  // The newest AUTOSAVE_KEEP autosaves stay; the older ones go.
  async function pruneAutosaves() {
    const dir = saves();
    const list = [];
    for (const n of await fs.promises.readdir(dir).catch(() => [])) {
      if (!AUTOSAVE.test(n)) continue;
      const st = await fs.promises.stat(path.join(dir, n)).catch(() => null);
      if (st?.isFile()) list.push({ n, t: st.mtimeMs });
    }
    list.sort((a, b) => b.t - a.t || (a.n < b.n ? -1 : 1));
    for (const { n } of list.slice(AUTOSAVE_KEEP)) await fs.promises.rm(path.join(dir, n), { force: true }).catch((err) => log?.warn(`cannot remove ${n}: ${err.message}`));
  }

  const writes = new Set();
  holdQuit?.(() => (writes.size ? Promise.all(writes) : null), 15000);
  let running = false;
  let quitSaved = false;
  let waiting = null;
  ipcMain.on('conquest:running', (e, on) => { running = !!on; });
  const win = getWindow?.();
  if (win) {
    const closeNow = () => {
      if (waiting) clearTimeout(waiting);
      waiting = null;
      quitSaved = true;
      if (!win.isDestroyed()) win.close();
    };
    ipcMain.on('conquest:quitSaved', closeNow);
    win.on('close', (e) => {
      if (!running || quitSaved || win.webContents.isCrashed()) return;
      e.preventDefault();
      if (waiting) return;
      waiting = setTimeout(() => { log?.warn('the page did not save before closing'); closeNow(); }, QUIT_SAVE_MS);
      win.webContents.send('conquest:quitSave');
    });
  }

  ipcMain.handle('conquest:save', async (e, name, text) => {
    const file = saveFile(name);
    if (!file) return { ok: false, code: 'badName' };
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_SAVE_BYTES) return { ok: false, code: 'badText' };
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const work = (async () => {
      try {
        await fs.promises.mkdir(saves(), { recursive: true });
        await fs.promises.writeFile(tmp, text, 'utf8');
        await fs.promises.rename(tmp, file);
        if (AUTOSAVE.test(path.basename(file))) await pruneAutosaves();
        return { ok: true, name, file };
      } catch (err) {
        await fs.promises.rm(tmp, { force: true }).catch(() => {});
        log?.warn(`cannot save ${file}: ${err.message}`);
        return failure(err);
      }
    })();
    writes.add(work);
    work.finally(() => writes.delete(work));
    return work;
  });

  ipcMain.handle('conquest:load', async (e, name) => {
    const file = saveFile(name);
    if (!file) return { ok: false, code: 'badName' };
    try {
      const st = await fs.promises.stat(file);
      if (st.size > MAX_SAVE_BYTES) return { ok: false, code: 'tooBig' };
      return { ok: true, name, text: await fs.promises.readFile(file, 'utf8'), meta: await readMeta(file) };
    } catch (err) {
      return failure(err);
    }
  });

  // Newest first.
  ipcMain.handle('conquest:list', async () => {
    let names;
    try { names = await fs.promises.readdir(saves()); } catch (err) { return err.code === 'ENOENT' ? { ok: true, items: [] } : failure(err); }
    const items = [];
    for (const n of names) {
      if (!n.endsWith(SAVE_EXT)) continue;
      try {
        const st = await fs.promises.stat(path.join(saves(), n));
        if (st.isFile()) items.push({ name: n.slice(0, -SAVE_EXT.length), size: st.size, mtime: st.mtimeMs, meta: await readMeta(path.join(saves(), n)) });
      } catch {}
    }
    items.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : 1));
    return { ok: true, items };
  });
}

module.exports = { register, workerSource, readData, readMeta, uiModules, wording, wordingPrompt, SAVE_EXT };
