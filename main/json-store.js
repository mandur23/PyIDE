// A JSON file in the user data folder that the app writes whole (trusted-projects.json, project-roots.json). Reading
// tells a missing file from one that cannot be read: written over after a failed read, the file lost every entry.
const fs = require('fs');

// -> {value} as read, {value: undefined} when there is no file, or null when the file is there but cannot be read now
// (locked by a virus scanner, no permission): the caller must not write over it. A file that is not JSON of the shape
// valid() accepts (hand-edited, truncated) is kept as <file>.bak and reads as no file, so the next write loses nothing.
function readStore(file, valid) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { return err.code === 'ENOENT' ? { value: undefined } : null; }
  try {
    // Saved by Notepad or PowerShell 5, it starts with a byte order mark, which JSON.parse refuses.
    const value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    if (valid(value)) return { value };
  } catch {}
  try { fs.copyFileSync(file, `${file}.bak`); } catch { return null; }
  return { value: undefined, corrupt: true };
}

// Through a temporary file, so a crash or a full disk mid-write leaves the old file. Throws.
function writeStore(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

module.exports = { readStore, writeStore };
