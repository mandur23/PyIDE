// Stand-in for the GitHub CLI in verify/github.mjs (PYIDE_GH points at a copy of gh.cmd, which runs this file). It
// records every call as a JSON line {argv, cwd} in FAKE_GH_LOG and answers the subcommands the github plugin runs from
// FAKE_GH_STATE, a JSON file the test writes: {auth: 'in' | 'out', account, prs: [gh pr list rows], views: {n: gh pr view}}.
// It never touches the network. `repo create` adds the remote itself with git, as gh does, but pushes nothing.
const fs = require('fs');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify({ argv, cwd: process.cwd() })}\n`);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
const opt = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const out = (text) => process.stdout.write(text);
const fail = (text, code = 1) => { process.stderr.write(text); process.exitCode = code; };
const pick = (obj, fields) => Object.fromEntries(fields.filter((f) => f in obj).map((f) => [f, obj[f]]));
const [cmd, sub] = argv;

if (cmd === '--version') {
  out('gh version 2.63.0 (2024-11-27)\nhttps://github.com/cli/cli/releases/tag/v2.63.0\n');
} else if (cmd === 'auth' && sub === 'status') {
  if (state.auth === 'in') out(`github.com\n  ✓ Logged in to github.com account ${state.account} (keyring)\n  - Active account: true\n  - Git operations protocol: https\n`);
  else fail('You are not logged into any GitHub hosts. To log in, run: gh auth login\n');
} else if (state.auth !== 'in') {
  fail('To get started with GitHub CLI, please run:  gh auth login\n', 4);
} else if (cmd === 'repo' && sub === 'create') {
  const name = argv[2];
  const url = `https://github.com/${state.account}/${name}`;
  execFileSync('git', ['remote', 'add', opt('--remote'), `${url}.git`], { cwd: opt('--source') });
  out(`✓ Created repository ${state.account}/${name} on GitHub\n  ${url}\n✓ Added remote ${url}.git\n✓ Pushed commits to ${url}.git\n`);
} else if (cmd === 'pr' && sub === 'list') {
  const want = opt('--state') || 'open';
  const fields = (opt('--json') || '').split(',');
  const list = state.prs.filter((p) => (want === 'all' || (want === 'open' ? p.state === 'OPEN' : p.state !== 'OPEN'))
    && (opt('--author') !== '@me' || p.author.login === state.account));
  out(JSON.stringify(list.slice(0, Number(opt('--limit') || 30)).map((p) => pick(p, fields))));
} else if (cmd === 'pr' && sub === 'view') {
  const pr = state.views[argv[2]];
  if (!pr) fail(`no pull requests found for branch "${argv[2]}"\n`);
  else out(JSON.stringify(pick(pr, (opt('--json') || '').split(','))));
} else if (cmd === 'pr' && sub === 'checkout') {
  const pr = state.views[argv[2]];
  if (!pr) fail(`could not find pull request #${argv[2]}\n`);
  else out(`Switched to branch '${pr.headRefName}'\n`);
} else {
  fail(`fake gh: unknown command ${argv.join(' ')}\n`);
}
