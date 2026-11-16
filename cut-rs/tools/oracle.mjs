// The JavaScript editor as the reference for the Rust port: runs functions of a module under renderer/features/cut
// (or of a scenario under tools/scenarios, which builds its inputs in JavaScript) on the inputs a Rust test sends,
// so both sides can be compared value by value.
//   stdin:  { "module": "time", "calls": [["rescale", 90000, 90000], ...] }   or   { "scenario": "formats", ... }
//   stdout: [ result, ... ]   one per call (awaited); a call that throws gives { "$error": message }
// Binary arguments come as { "$bytes": base64 } and arrive as a Uint8Array. Typed arrays in results go out as plain
// arrays. Numbers that JSON cannot hold (NaN, Infinity) and undefined come back as null.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CUT = path.resolve(HERE, '..', '..', 'renderer', 'features', 'cut');

let text = '';
// Decoded as one stream: a character split across two chunks must not turn into U+FFFD.
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) text += chunk;
const revive = (key, v) => (v && typeof v === 'object' && typeof v.$bytes === 'string' ? new Uint8Array(Buffer.from(v.$bytes, 'base64')) : v);
const { module: name, scenario, calls } = JSON.parse(text, revive);
// The model's scenarios are CommonJS beside the editor's modules: { "module": "scenario/<name>" } loads
// tools/scenarios/<name>.cjs.
const cjs = /^scenario\/([a-z0-9-]+)$/.exec(name ?? '');
const which = scenario ?? (cjs ? 'cjs' : name);
if (!/^[a-z0-9]+$/.test(which)) throw new Error(`not a module name: ${which}`);
const api = scenario
  ? await import(pathToFileURL(path.join(HERE, 'scenarios', `${scenario}.mjs`)))
  : require(cjs ? path.join(HERE, 'scenarios', `${cjs[1]}.cjs`) : path.join(CUT, `${which}.js`));
const out = [];
for (const [fn, ...args] of calls) {
  try {
    const value = await api[fn](...args);
    out.push(value === undefined || (typeof value === 'number' && !Number.isFinite(value)) ? null : value);
  } catch (err) {
    out.push({ $error: String(err?.message || err) });
  }
}
const plain = (key, v) => (ArrayBuffer.isView(v) && !(v instanceof DataView) ? Array.from(v) : v);
// A scenario may leave timers behind (the tests it runs do): exit once the answer is out.
process.stdout.write(JSON.stringify(out, plain), () => process.exit(0));
