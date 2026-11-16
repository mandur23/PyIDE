// Oracle scenarios for cut-app's files module: main/cut/project.js, paths.js and runs.js in plain Node, on the paths
// and folders a Rust test hands over, so names, results and the files left behind can be compared.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'main', 'cut');
const { createProjects } = require(path.join(MAIN, 'project.js'));
const { createRun } = require(path.join(MAIN, 'runs.js'));
const paths = require(path.join(MAIN, 'paths.js'));

// Another run's identity, alive only to itself: what a run that is gone left behind.
const fakeRun = (pid, run, started) => ({
  pid, run, started, alive: (m) => m?.run === run, mark: (extra) => ({ pid, run, started, ...extra }),
});
const open = (dir) => createProjects({ autosaveDir: dir, run: createRun() });

export const localPath = (p) => paths.localPath(p);
export const extOf = (p) => paths.extOf(p);

// The autosave file name createProjects gives a key at a time: a fresh instance in its own folder, Date.now fixed.
// The name is read back from the folder, as the file system stores it (a lone surrogate as U+FFFD).
export async function autosaveName(dir, key, now, latest) {
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const r = await open(dir).autosave(key, '{}', { latest });
    return r.error ? { code: r.code } : fs.readdirSync(dir).find((n) => n.endsWith('.ncut'));
  } finally {
    Date.now = realNow;
  }
}

export const projectRead = (dir, p) => open(dir).projectRead(p);
export const projectWrite = (dir, p, text, mtime) => open(dir).projectWrite(p, text, mtime == null ? {} : { mtime });
export const mtimeOf = (p) => fs.statSync(p).mtimeMs;

// A session of another run that never ended, with its autosaves.
export async function abandon(dir, pid, run, started, key, texts) {
  const p = createProjects({ autosaveDir: dir, run: fakeRun(pid, run, started) });
  await p.sessionStart(key, 1);
  for (const text of texts) await p.autosave(key, text);
  return null;
}

export const recovery = (dir) => open(dir).recovery();
export const autosavesOf = (dir, key) => open(dir).autosavesOf(key);
