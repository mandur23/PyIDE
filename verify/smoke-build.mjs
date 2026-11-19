// The built app opens: Code, Craft and Cut from the packed exe in SMOKE_EXE (docs/development.md, release step 3).
// Exits with 1 when a check fails. Run it by itself, or with `set -o pipefail` when its output is piped: a pipe to
// grep or tail otherwise hides the failure from the commands after it.
// Usage: SMOKE_EXE="<dist>\win-unpacked\Nano Studio.exe" node verify/smoke-build.mjs
import { launch } from './lib.mjs';
import { spawnSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const exe = process.env.SMOKE_EXE;
const tmp = (p) => mkdtempSync(path.join(tmpdir(), `pyide-smoke-${p}-`));

const code = await launch({ fixture: 'core', port: 9781, name: 'smoke-code', exe, userData: tmp('code-data') });
await code.until('window.__ideReady === true', 'Code opened', 60000);
code.check(true, `Code window: ${await code.js('document.title')}`);
code.check(await code.js('!!(ide.collab && typeof ide.collab.state === "function") && [...document.querySelectorAll("*")].length > 0'), 'Code: collaboration module loaded (ide.collab)');
const cutGone = await code.js(`(async () => (await ide.api.invoke('plugins:list')).every((p) => p.id !== 'cut'))()`).catch((e) => String(e));
code.check(cutGone === true, `Code: the JavaScript Cut plugin is not in the build (${cutGone})`);
code.close();

const craft = await launch({ fixture: 'core', port: 9782, name: 'smoke-craft', exe, mode: 'craft', ready: `!!document.querySelector('#craftHost')`, userData: tmp('craft-data'), env: { PYIDE_CRAFT_HOME: tmp('craft-home') } });
await craft.until(`!!document.querySelector('#craftHost')`, 'Craft opened', 60000);
craft.check(true, 'Craft host shown');
craft.close();

// Cut is the Rust program: every way of opening it, against a stand-in and then the packed nano-studio-cut.exe.
const args = [fileURLToPath(new URL('./cut-rust-launch.mjs', import.meta.url)), ...(exe ? ['--exe', exe] : [])];
const cut = spawnSync(process.execPath, args, { stdio: 'inherit' });
craft.check(cut.status === 0, `Cut: verify/cut-rust-launch.mjs ${exe ? `--exe ${exe}` : '(source tree)'} passed`);
const all = [...code.results, ...craft.results];
const failed = all.filter((r) => !r.ok).length;
const errors = [...code.consoleErrors, ...craft.consoleErrors];
if (errors.length) console.log(`renderer exceptions:\n  ${errors.join('\n  ')}`);
console.log(`${all.length - failed}/${all.length} passed`);
process.exit(failed || errors.length ? 1 : 0);
