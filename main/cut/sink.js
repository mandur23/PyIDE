// The export file sink: mp4write in the renderer streams the file through cut:writeAt into <path>.part, then
// cut:writeClose renames it over the final name (or deletes it). Writes of one sink run in the order they were sent,
// whether or not the renderer awaits each. A sink belongs to the window that opened it: another window cannot write to
// it or close it, and closing the window removes its part files.
//
// Each run lists its open part files in <journalDir>/<pid>-<run>.json, so the parts a crashed or killed run left behind
// are removed at the next start.
const fs = require('fs');
const path = require('path');
const { WRITE_LIMIT } = require('./limits');
const { OUTPUT, fail, writableFile } = require('./paths');
const { renameOver, writeAtomic } = require('./project');

const JOURNAL = /^(\d+)-([0-9a-f]+)\.json$/;

const asBytes = (b) => (b instanceof Uint8Array ? b : ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
  : b instanceof ArrayBuffer ? new Uint8Array(b) : null);

function createSinks({ journalDir, run, onCommit, log }) {
  const sinks = new Map(); // id -> {owner, final, part, fh, end, written, queue, failed}
  const journal = path.join(journalDir, `${run.pid}-${run.run}.json`);
  let nextId = 1;

  async function saveJournal() {
    const parts = [...sinks.values()].map((s) => s.part);
    try {
      if (parts.length) {
        await fs.promises.mkdir(journalDir, { recursive: true });
        await writeAtomic(journal, JSON.stringify(run.mark({ parts })));
      } else await fs.promises.rm(journal, { force: true });
    } catch (err) { log?.warn?.(`export journal: ${err.message}`); }
  }

  // Part files of runs that are gone. Only names ending in .part are removed, whatever a journal says.
  async function sweep() {
    let names = [];
    try { names = await fs.promises.readdir(journalDir); } catch { return; }
    for (const name of names) {
      if (!JOURNAL.test(name)) continue;
      const file = path.join(journalDir, name);
      let marker = null;
      try { marker = JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch {}
      if (marker && run.alive(marker)) continue;
      for (const part of Array.isArray(marker?.parts) ? marker.parts : []) {
        if (typeof part === 'string' && /\.part$/i.test(part)) await fs.promises.rm(part, { force: true }).catch(() => {});
      }
      await fs.promises.rm(file, { force: true }).catch(() => {});
    }
  }

  async function open(owner, p) {
    const target = await writableFile(p, OUTPUT);
    if (target.error) return target;
    const part = `${target.path}.part`;
    if ([...sinks.values()].some((s) => s.part.toLowerCase() === part.toLowerCase())) return fail('busy', 'this file is being written');
    let fh;
    try { fh = await fs.promises.open(part, 'w'); } catch (err) { return fail('io', err.message); }
    const id = `${run.run}-${nextId++}`;
    sinks.set(id, { owner, final: target.path, part, fh, end: 0, written: 0, queue: Promise.resolve(), failed: null });
    await saveJournal();
    return { id, part };
  }

  const sinkOf = (owner, id) => {
    const s = sinks.get(id);
    return s && s.owner === owner ? s : null;
  };

  function write(owner, id, bytes, position) {
    const s = sinkOf(owner, id);
    if (!s) return Promise.resolve(fail('badArgs', 'no such export file'));
    const data = asBytes(bytes);
    if (!data || data.byteLength > WRITE_LIMIT) return Promise.resolve(fail('badArgs', 'not bytes, or too many at once'));
    if (position != null && !(Number.isSafeInteger(position) && position >= 0)) return Promise.resolve(fail('badArgs', 'not a file position'));
    const step = s.queue.then(async () => {
      if (s.failed) return fail('io', s.failed);
      const at = position == null ? s.end : position;
      try {
        let done = 0;
        while (done < data.byteLength) {
          const { bytesWritten } = await s.fh.write(data, done, data.byteLength - done, at + done);
          done += bytesWritten;
        }
      } catch (err) {
        s.failed = err.code === 'ENOSPC' ? 'the disk is full' : err.message;
        return fail(err.code === 'ENOSPC' ? 'diskFull' : 'io', s.failed);
      }
      s.end = Math.max(s.end, at + data.byteLength);
      s.written += data.byteLength;
      return { ok: true, end: s.end };
    });
    s.queue = step;
    return step;
  }

  async function close(owner, id, { commit = false } = {}) {
    const s = sinkOf(owner, id);
    if (!s) return fail('badArgs', 'no such export file');
    sinks.delete(id);
    await s.queue;
    let result;
    try {
      if (commit && !s.failed) await s.fh.sync();
      await s.fh.close();
      if (commit && !s.failed) {
        await renameOver(s.part, s.final);
        result = { ok: true, path: s.final, bytes: s.end };
      } else {
        await fs.promises.rm(s.part, { force: true });
        result = commit ? fail('io', s.failed) : { ok: true, path: null, bytes: 0, aborted: true };
      }
    } catch (err) {
      // A finished file that cannot take the target's place (a player has the target open) is kept: deleting it threw
      // away the whole render.
      const busy = err.code === 'EBUSY' || err.code === 'EPERM';
      if (busy && commit && !s.failed) result = { ...fail('busy', err.message), part: s.part };
      else {
        await fs.promises.rm(s.part, { force: true }).catch(() => {});
        result = fail(busy ? 'busy' : 'io', err.message);
      }
    }
    await saveJournal();
    if (result.ok && result.path) await onCommit?.(result.path);
    return result;
  }

  // The window that opened these sinks is gone: their part files go with it.
  async function ownerGone(owner) {
    const mine = [...sinks].filter(([, s]) => s.owner === owner).map(([id]) => id);
    for (const id of mine) await close(owner, id, { commit: false });
  }

  async function closeAll() {
    for (const [id, s] of [...sinks]) await close(s.owner, id, { commit: false });
  }

  return { open, write, close, ownerGone, closeAll, sweep, openParts: () => [...sinks.values()].map((s) => s.part) };
}

module.exports = { createSinks, asBytes };
