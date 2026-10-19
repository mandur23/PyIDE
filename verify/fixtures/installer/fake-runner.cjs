// Stand-in for system commands in verify/installer.mjs (PYIDE_INSTALLER_RUNNER): records every call as a JSON line in
// PYIDE_INSTALLER_RUNNER_LOG, reports no tools installed until a fake winget install, and never changes the system.
const fs = require('fs');

const LOG = process.env.PYIDE_INSTALLER_RUNNER_LOG;
const STATE = `${LOG}.installed.json`;
const PROBES = { git: 'Git.Git', py: 'Python.Python.3.13', node: 'OpenJS.NodeJS.LTS' };
const VERSIONS = { 'Git.Git': 'git version 2.51.0.windows.1', 'Python.Python.3.13': 'Python 3.13.9', 'OpenJS.NodeJS.LTS': 'v22.20.0' };
// Installing this id hangs until cancelled, to exercise cancelling a main-process job.
const HANGS = 'OpenJS.NodeJS.LTS';

const installed = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return []; } };

exports.run = async (cmd, args, { signal, onData } = {}) => {
  fs.appendFileSync(LOG, `${JSON.stringify({ cmd, args })}\n`);
  if (cmd === 'winget' && args[0] === '--version') return { code: 0, out: 'v1.11.510' };
  if (cmd === 'winget' && args[0] === 'install') {
    const id = args[args.indexOf('--id') + 1];
    onData?.(`Found ${id} [${id}] Version 1.0\nDownloading https://example.invalid/${id}.exe\n`);
    if (id === HANGS) {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      return { code: 1, out: '' };
    }
    fs.writeFileSync(STATE, JSON.stringify([...installed(), id]));
    onData?.('Successfully installed\n');
    return { code: 0, out: 'Successfully installed' };
  }
  const id = PROBES[cmd];
  if (id && installed().includes(id)) return { code: 0, out: VERSIONS[id] };
  return { code: -1, out: `spawn ${cmd} ENOENT` };
};

exports.exists = () => false;
