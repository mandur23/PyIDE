// Removes the test folders suites leave in %TEMP% (pyide-<suite>-xxxxxx: project copies, user data with Chromium's
// profile, venvs, feeds). A suite removes its own when it exits (verify/lib.mjs); this catches what a crashed or killed
// suite left behind. Only folders untouched for --age minutes (default 360) go, so running suites keep theirs.
// Usage: node verify/clean.mjs [--age <minutes>] [--dry-run]   (npm run clean:tests)
import { readdirSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const argv = process.argv.slice(2);
const ageAt = argv.indexOf('--age');
const minutes = ageAt >= 0 ? Number(argv[ageAt + 1]) : 360;
if (!Number.isFinite(minutes) || minutes < 0) throw new Error('--age takes a number of minutes');
const dryRun = argv.includes('--dry-run');
const cutoff = Date.now() - minutes * 60000;

const root = tmpdir();
let removed = 0, kept = 0, failed = 0;
for (const name of readdirSync(root)) {
  if (!/^pyide-/i.test(name)) continue;
  const dir = path.join(root, name);
  let st;
  try { st = statSync(dir); } catch { continue; }
  if (!st.isDirectory()) continue;
  if (st.mtimeMs > cutoff) { kept++; continue; }
  if (dryRun) { console.log(`would remove ${dir}`); removed++; continue; }
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); removed++; } catch { failed++; }
}
console.log(`${dryRun ? 'would remove' : 'removed'} ${removed} test folder(s) from ${root}; kept ${kept} newer than ${minutes} min${failed ? `; ${failed} in use` : ''}`);
