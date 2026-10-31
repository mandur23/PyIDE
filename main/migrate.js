// The first start of Nano Studio after PyIDE: when this user data has no settings.json and PyIDE's user data sits
// beside it (%APPDATA%\PyIDE next to %APPDATA%\Nano Studio), the settings (the Claude Code IDE settings among them),
// the plugins and their on/off state, the interpreter probes, the project roots and the trusted projects are copied
// over, once; what could not be copied is tried again at later starts. Logs, caches, indexes and backups stay behind, and PyIDE's folder is only read: PyIDE keeps working as it
// was. The trusted projects come along because without that file main/trust.js trusts every recent project, also
// those PyIDE kept in Safe Mode.
const fs = require('fs');
const path = require('path');

const LEGACY = 'PyIDE';
// settings.json goes last: its absence is what starts a migration, so one that stopped half-way runs again.
const ITEMS = ['plugin-state.json', 'interpreters.json', 'project-roots.json', 'trusted-projects.json', 'plugins', 'settings.json'];
const MARKER = 'migrated-from-pyide.json';
// PyIDE's own update feed, saved as the feed setting when the user applied Settings > Updates unchanged: Nano Studio
// would then look for PyIDE's installers.
const LEGACY_FEED = 'https://github.com/mandur23/Portfolio-Nano-/releases/download/pyide/';

const legacyDir = (userData) => path.join(path.dirname(path.resolve(userData)), LEGACY);

// A file that is not settings JSON is copied as it is: main.js keeps it as settings.json.bak, as for its own.
function copySettings(from, to) {
  const text = fs.readFileSync(from, 'utf8');
  let settings = null;
  try { settings = JSON.parse(text); } catch {}
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return fs.writeFileSync(to, text, { flag: 'wx' });
  if (String(settings['updates.feedUrl'] || '').trim() === LEGACY_FEED) delete settings['updates.feedUrl'];
  fs.writeFileSync(to, JSON.stringify(settings, null, 2), { flag: 'wx' });
}

// Returns {from, copied, failed} after a migration, else null. Never throws: the app starts either way.
function migrate(userData, { log = console } = {}) {
  const from = legacyDir(userData);
  const markerFile = path.join(userData, MARKER);
  let marker = null;
  try {
    if (path.resolve(userData).toLowerCase() === from.toLowerCase()) return null;
    if (fs.existsSync(markerFile)) {
      try { marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')); } catch {}
      if (!Array.isArray(marker?.failed) || !marker.failed.length) return null;
    } else if (fs.existsSync(path.join(userData, 'settings.json'))) return null;
    if (!fs.statSync(from, { throwIfNoEntry: false })?.isDirectory()) return null;
  } catch { return null; }
  const copied = [];
  const failed = [];
  fs.mkdirSync(userData, { recursive: true });
  for (const name of marker ? ITEMS.filter((n) => marker.failed.includes(n)) : ITEMS) {
    const src = path.join(from, name);
    const dest = path.join(userData, name);
    try {
      const stat = fs.statSync(src, { throwIfNoEntry: false });
      if (!stat) continue;
      if (name === 'settings.json') copySettings(src, dest);
      else if (stat.isDirectory()) fs.cpSync(src, dest, { recursive: true, force: false, errorOnExist: false });
      else fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
      copied.push(name);
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      failed.push(name);
      log.warn(`could not copy ${src}: ${err.message}`);
    }
  }
  if (failed.includes('settings.json')) {
    log.warn(`settings were not imported from ${from}; the next start tries again`);
    return { from, copied, failed };
  }
  const all = [...new Set([...(Array.isArray(marker?.copied) ? marker.copied : []), ...copied])];
  try {
    fs.writeFileSync(markerFile, JSON.stringify({ from, at: marker?.at || new Date().toISOString(), copied: all, failed, noticeShown: !!marker?.noticeShown }, null, 2));
  } catch (err) { log.warn(`cannot write ${MARKER}: ${err.message}`); }
  log.info(`imported ${copied.join(', ') || 'nothing'} from ${from}${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
  return { from, copied, failed };
}

// The one-time notice of a migration: {from} the first time it is asked for, then null.
function takeNotice(userData) {
  const file = path.join(userData, MARKER);
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!m || m.noticeShown) return null;
    fs.writeFileSync(file, JSON.stringify({ ...m, noticeShown: true }, null, 2));
    return { from: String(m.from || ''), copied: Array.isArray(m.copied) ? m.copied : [] };
  } catch { return null; }
}

module.exports = { migrate, takeNotice, legacyDir, MARKER };
