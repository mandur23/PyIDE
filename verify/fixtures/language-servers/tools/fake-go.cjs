// `go` stand-in for verify/language-servers.mjs: `go install <module>@<version>` writes gopls.exe into GOBIN and
// records its arguments next to it.
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args[0] !== 'install' || !process.env.GOBIN) { console.error('unexpected go call', args.join(' ')); process.exit(2); }
console.log(`go: downloading ${args[1]}`);
fs.writeFileSync(path.join(process.env.GOBIN, 'gopls.exe'), 'stand-in');
fs.writeFileSync(path.join(process.env.GOBIN, 'go-args.json'), JSON.stringify({ args, env: { GOFLAGS: process.env.GOFLAGS, GOTOOLCHAIN: process.env.GOTOOLCHAIN } }));
