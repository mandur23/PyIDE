// Korean for a server's mods: each jar in mods/ keeps its text in assets/<namespace>/lang/en_us.json and, when it has
// one, its Korean in ko_kr.json; what neither that nor the server's resource pack (resourcepack/assets/<namespace>/
// lang/ko_kr.json) has yet is translated and added to the pack, whose language files Minecraft merges line by line
// over the mods' own. Lines already in the pack (an earlier run's, or the user's own edits) are never translated
// again. A translation is kept only when it has the same format codes as the English (%s, %1$d, §7, line breaks):
// the game fills those in, and a missing %s shows an error or crashes a tooltip.
const fs = require('fs');
const path = require('path');
const { openZip } = require('./zipfile');

const LANG = /^assets\/([a-z0-9_.-]+)\/lang\/(en_us|ko_kr)\.json$/;
const BATCH_KEYS = 120;
const BATCH_CHARS = 6000;

const parse = (buf) => {
  try {
    const v = JSON.parse(buf.toString('utf8').replace(/^﻿/, ''));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
};
const strings = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => typeof v === 'string'));
const packFile = (dir, ns) => path.join(dir, 'resourcepack', 'assets', ns, 'lang', 'ko_kr.json');
const readPack = (dir, ns) => (fs.existsSync(packFile(dir, ns)) ? strings(parse(fs.readFileSync(packFile(dir, ns)))) : {});

// The format codes of a line, in a canonical order: what a translation must keep.
const CODES = /%(\d+\$)?[-#+ 0,(]*\d*(\.\d+)?[a-zA-Z%]|§[0-9a-fk-orA-FK-OR]|\n/g;
const codesOf = (text) => (text.match(CODES) || []).sort().join('\u0000');
const sameCodes = (en, ko) => typeof ko === 'string' && ko.trim() !== '' && codesOf(en) === codesOf(ko);

// The server's mods with English text -> [{jar, ns, total, missing: {key: english}}]; a jar whose language file
// cannot be read is left out and named in skipped.
function scan(dir) {
  const modsDir = path.join(dir, 'mods');
  const jars = fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter((n) => n.endsWith('.jar')).sort() : [];
  const mods = [];
  const skipped = [];
  for (const jar of jars) {
    let zip;
    try {
      zip = openZip(path.join(modsDir, jar));
      const found = new Map(); // namespace -> {en_us, ko_kr}
      for (const name of zip.names) {
        const m = LANG.exec(name);
        if (m) found.set(m[1], { ...found.get(m[1]), [m[2]]: name });
      }
      for (const [ns, files] of found) {
        if (!files.en_us) continue;
        const en = strings(parse(zip.read(files.en_us)));
        if (!Object.keys(en).length) { skipped.push(jar); continue; }
        const own = files.ko_kr ? strings(parse(zip.read(files.ko_kr))) : {};
        const pack = readPack(dir, ns);
        const missing = Object.fromEntries(Object.entries(en).filter(([k, v]) => v.trim() && !own[k] && !pack[k]));
        mods.push({ jar, ns, total: Object.keys(en).length, missing });
      }
    } catch { skipped.push(jar); } finally { zip?.close(); }
  }
  return { mods, skipped };
}

// Each mod's missing lines in batches small enough for one answer.
function batches(missing) {
  const out = [];
  let cur = {};
  let chars = 0;
  for (const [k, v] of Object.entries(missing)) {
    if (Object.keys(cur).length >= BATCH_KEYS || (chars && chars + v.length > BATCH_CHARS)) { out.push(cur); cur = {}; chars = 0; }
    cur[k] = v;
    chars += v.length;
  }
  if (Object.keys(cur).length) out.push(cur);
  return out;
}

// The JSON object in an answer (a model may wrap it in a code fence or a sentence).
function answerObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? parse(Buffer.from(text.slice(start, end + 1))) : null;
}

const SYSTEM = `You translate Minecraft mod text from English into natural Korean as Korean Minecraft players know it (아이템, 블록, 인챈트, 발전 과제, 레드스톤…).
You get one JSON object of translation keys and English lines. Answer with one JSON object with exactly the same keys and the Korean lines, nothing else.
Keep every format code exactly as it is: %s, %d, %1$s, %2$s and the like, § colour codes such as §7 and §r, and line breaks (\\n). Keep names of mods and of keys pressed (Shift, Ctrl) as they are.`;

// Translates what scan() found and writes it into the server's resource pack. translate(system, prompt, signal)
// -> Promise<text>. -> {translated, rejected (format codes changed), failed (no answer), files: [{ns, file, added}]}.
async function translateMods(dir, { mods, translate, log, signal }) {
  const result = { translated: 0, rejected: 0, failed: 0, files: [] };
  for (const mod of mods) {
    const todo = batches(mod.missing);
    if (!todo.length) continue;
    log(`${mod.jar} (${mod.ns}): ${Object.keys(mod.missing).length} lines\n`);
    let added = 0;
    for (const [i, batch] of todo.entries()) {
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { expected: true, code: 'cancelled' });
      let answer = null;
      try {
        answer = answerObject(await translate(SYSTEM, JSON.stringify(batch, null, 1), signal));
      } catch (err) {
        if (signal?.aborted || err.code === 'cancelled') throw Object.assign(new Error('Cancelled'), { expected: true, code: 'cancelled' });
        if (err.code === 'not-installed' || err.code === 'auth') throw err;
        log(`  ${i + 1}/${todo.length}: ${err.message}\n`);
      }
      if (!answer) { result.failed += Object.keys(batch).length; continue; }
      // Read again before writing: the user may have edited the file while the answer was coming.
      const pack = readPack(dir, mod.ns);
      let ok = 0;
      for (const [k, en] of Object.entries(batch)) {
        if (pack[k]) continue;
        if (sameCodes(en, answer[k])) { pack[k] = answer[k]; ok++; } else result.rejected++;
      }
      fs.mkdirSync(path.dirname(packFile(dir, mod.ns)), { recursive: true });
      fs.writeFileSync(packFile(dir, mod.ns), `${JSON.stringify(pack, null, 2)}\n`);
      added += ok;
      result.translated += ok;
      log(`  ${i + 1}/${todo.length}: ${ok} translated\n`);
    }
    if (added) result.files.push({ ns: mod.ns, file: packFile(dir, mod.ns), added });
  }
  return result;
}

module.exports = { scan, translateMods, sameCodes, batches };
