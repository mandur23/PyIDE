// Spell checker backend: Hunspell en_US (dictionary-en) through nspell on a worker thread. The renderer extracts the
// words and caches verdicts, so only words it has not seen before cross IPC. The project dictionary is
// <project>/.pyide/dictionary.txt, one word per line.
const fs = require('fs');
const path = require('path');
const { isMainThread, parentPort, workerData } = require('worker_threads');

// ---------- worker ----------
let speller = null;
const suggestions = new Map();

function load({ nspell, aff, dic }) {
  speller ??= require(nspell)(fs.readFileSync(aff), fs.readFileSync(dic));
  return speller;
}

// Typos are usually a swapped pair or a missing double letter; rank those above other one-edit words that nspell
// lists first (for "nmae": "name" before "nae", for "coment": "comment" before "cement").
function distance(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const same = a[i - 1] === b[j - 1];
      const doubled = b[j - 1] === b[j - 2] || b[j - 1] === b[j];
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + (doubled ? 0.6 : 1), d[i - 1][j - 1] + (same ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 0.6);
    }
  }
  return d[a.length][b.length];
}

function matchCase(word, s) {
  return word[0] === word[0].toUpperCase() && s[0] === s[0].toLowerCase() ? s[0].toUpperCase() + s.slice(1) : s;
}

const SPELL = {
  check(files, words) {
    const s = load(files);
    // Words arrive in lower case; a name the dictionary only knows capitalized (english, monday) is not a typo.
    return words.filter((w) => !s.correct(w) && !s.correct(w[0].toUpperCase() + w.slice(1)));
  },
  suggest(files, word, limit = 5) {
    if (!suggestions.has(word)) {
      const list = load(files).suggest(word);
      const ranked = list.map((s, i) => ({ s, i, d: distance(word, s) })).sort((x, y) => x.d - y.d || x.i - y.i).map((x) => matchCase(word, x.s));
      suggestions.set(word, [...new Set(ranked)]);
    }
    return suggestions.get(word).slice(0, limit);
  },
};

if (!isMainThread && workerData?.role === 'pyide-spellcheck') {
  parentPort.on('message', ({ id, op, args }) => {
    try { parentPort.postMessage({ id, result: SPELL[op](...args) }); } catch (e) { parentPort.postMessage({ id, error: e.message }); }
  });
}

// ---------- main ----------
// Main side; worker-host evaluates this file as the worker (the role check above).
const spell = isMainThread ? require('../worker-host').fileWorker(__filename, 'pyide-spellcheck') : null;

const projectDictionary = (root) => path.join(root, '.pyide', 'dictionary.txt');

function register(ctx) {
  // Inside app.asar in an installed build; the worker reads through Electron's asar support like the main thread.
  const dictDir = path.join(ctx.appDir, 'node_modules', 'dictionary-en');
  const files = { nspell: require.resolve('nspell'), aff: path.join(dictDir, 'index.aff'), dic: path.join(dictDir, 'index.dic') };

  ctx.ipcMain.handle('spellcheck:check', (_e, words) => spell('check', files, words));
  ctx.ipcMain.handle('spellcheck:suggest', (_e, word, limit) => spell('suggest', files, word, limit));
  ctx.ipcMain.handle('spellcheck:readProjectDictionary', async (_e, root) => {
    try {
      return (await fs.promises.readFile(projectDictionary(root), 'utf8')).split(/\r?\n/).map((w) => w.trim()).filter(Boolean);
    } catch {
      return [];
    }
  });
  ctx.ipcMain.handle('spellcheck:writeProjectDictionary', async (_e, root, words) => {
    const file = projectDictionary(root);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const sorted = [...new Set(words.map((w) => w.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    await fs.promises.writeFile(file, sorted.length ? `${sorted.join('\n')}\n` : '', 'utf8');
    return file;
  });
}

module.exports = { register };
