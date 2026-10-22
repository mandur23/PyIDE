// A stand-in external tool for verify/run-automation.mjs.
// node tool.js <log> <label> [sleepMs] [exitCode] [...args]: appends a start line (with its cwd and the remaining
// arguments, macros already expanded) and, after sleepMs, an end line to <log> as JSON, then exits with exitCode.
const fs = require('fs');
const path = require('path');

const [log, label, sleepMs = '0', code = '0', ...rest] = process.argv.slice(2);
const line = (o) => fs.appendFileSync(path.resolve(log), `${JSON.stringify(o)}\n`);
line({ label, phase: 'start', t: Date.now(), cwd: process.cwd(), args: rest });
console.log(`${label} says hi`);
setTimeout(() => {
  line({ label, phase: 'end', t: Date.now() });
  if (Number(code)) console.error(`${label} failed`);
  process.exitCode = Number(code);
}, Number(sleepMs));
