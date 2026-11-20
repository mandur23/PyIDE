// Removes what tests and builds leave behind.
//   node verify/clean.mjs                 the test folders suites leave in %TEMP% (pyide-<suite>-xxxxxx: project copies,
//                                         user data with Chromium's profile, venvs, feeds). A suite removes its own when
//                                         it exits (verify/lib.mjs); this catches what a crashed or killed suite left.
//                                         Only folders untouched for --age minutes (default 360) go, so running suites
//                                         keep theirs.
//   node verify/clean.mjs --all           the end of a piece of work (npm run clean:all): the same with --age 0, the
//                                         Rust tests' folders in %TEMP% (cut-app-<test>-<pid>), the suites' output in
//                                         verify/out (pictures, logs; downloads-cache and *-venv stay: they save the
//                                         downloads and the installs of the next run), and the folders of trial builds (%TEMP%\pyidedist-*).
//                                         Not while a suite, a Rust test or a release runs: their folders are among these.
// Never touched: dist/ (the installers kept on purpose), cut-rs/target (the build cache), anything outside these names.
// Usage: node verify/clean.mjs [--all] [--age <minutes>] [--dry-run]   (npm run clean:tests, npm run clean:all)
import { existsSync, readdirSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const argv = process.argv.slice(2);
const all = argv.includes('--all');
const ageAt = argv.indexOf('--age');
const minutes = ageAt >= 0 ? Number(argv[ageAt + 1]) : all ? 0 : 360;
if (!Number.isFinite(minutes) || minutes < 0) throw new Error('--age takes a number of minutes');
const dryRun = argv.includes('--dry-run');
const cutoff = Date.now() - minutes * 60000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The size of a folder in bytes (what could be read of it).
function sizeOf(p) {
  let st;
  try { st = statSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let n = 0;
  try { for (const e of readdirSync(p)) n += sizeOf(path.join(p, e)); } catch {}
  return n;
}

let removed = 0, kept = 0, failed = 0, bytes = 0;
function sweep(root, wanted, { files = false } = {}) {
  let names = [];
  try { names = readdirSync(root); } catch { return; }
  for (const name of names) {
    if (!wanted(name)) continue;
    const p = path.join(root, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (!st.isDirectory() && !files) continue;
    if (st.mtimeMs > cutoff) { kept++; continue; }
    const size = all ? sizeOf(p) : 0;
    if (dryRun) { console.log(`would remove ${p}`); removed++; bytes += size; continue; }
    try { rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); removed++; bytes += size; } catch { failed++; }
  }
}

sweep(tmpdir(), (n) => /^pyide-/i.test(n));
if (all) {
  sweep(tmpdir(), (n) => /^cut-app-/i.test(n));
  sweep(tmpdir(), (n) => /^pyidedist-/i.test(n));
  const out = path.join(ROOT, 'verify', 'out');
  if (existsSync(out)) sweep(out, (n) => n !== 'downloads-cache' && !/-venv$/.test(n), { files: true });
}
const where = all ? `${tmpdir()} and verify/out` : tmpdir();
console.log(`${dryRun ? 'would remove' : 'removed'} ${removed} ${all ? 'leftover(s)' : 'test folder(s)'} from ${where}${all ? ` (${Math.round(bytes / 1048576)} MB)` : ''}; kept ${kept} newer than ${minutes} min${failed ? `; ${failed} in use` : ''}`);
