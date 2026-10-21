// GitHub integration through the GitHub CLI (gh): finding gh and its login, Share Project on GitHub, and the pull
// requests of the project's GitHub repository. gh runs only in projects the user trusts (main/trust.js): it reads the
// repository's git configuration and runs git there. Errors composed here carry a `reason` the renderer translates;
// gh's and git's own output is passed through untranslated.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shell } = require('electron');
const textCodec = require('../text-codec');
const trust = require('../trust');

// Nothing can answer a prompt, so gh and git fail instead of waiting for one.
const ENV = {
  GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1', CLICOLOR: '0',
  GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_EDITOR: 'true', LC_ALL: 'C',
};
const PR_LIST_FIELDS = 'number,title,author,headRefName,baseRefName,state,isDraft,updatedAt,reviewDecision';
const PR_VIEW_FIELDS = 'title,body,author,commits,files,reviews,comments,statusCheckRollup,number,url,state,isDraft,baseRefName,headRefName,headRefOid';
const READ_TIMEOUT = 60000;
const WRITE_TIMEOUT = 10 * 60000;

// ---------- finding gh ----------
// PYIDE_GH names the gh to use ('none' simulates a missing install); otherwise PATH, then the usual install folders
// (the MSI, winget's links, scoop, Chocolatey), which also find a gh installed after PyIDE started.
function installDirs() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return [
    path.join(pf, 'GitHub CLI', 'gh.exe'), path.join(pf86, 'GitHub CLI', 'gh.exe'), path.join(local, 'Programs', 'GitHub CLI', 'gh.exe'),
    path.join(local, 'Microsoft', 'WinGet', 'Links', 'gh.exe'), path.join(os.homedir(), 'scoop', 'shims', 'gh.exe'),
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin', 'gh.exe'),
  ];
}

// gh.exe / gh.cmd / gh.bat in the PATH folders, in PATH and PATHEXT order. Not `where.exe gh`: like cmd, it looks in
// the current folder first, so a gh.exe in main's working folder would win. For the same reason empty and relative
// PATH entries (".", "bin", "\tools" on the current drive) and the working folder itself are skipped.
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
function ghOnPath(pathVar = process.env.PATH || '', cwd = process.cwd()) {
  const key = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const here = key(cwd);
  const order = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter((e) => ['.exe', '.cmd', '.bat'].includes(e));
  const exts = order.length ? order : ['.exe', '.cmd', '.bat'];
  for (const entry of String(pathVar).split(';')) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1').trim();
    if (!/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(dir) || key(dir) === here) continue;
    for (const ext of exts) {
      const p = path.join(dir, `gh${ext}`);
      if (isFile(p)) return p;
    }
  }
  return null;
}

let cached = null;
async function findGh() {
  const override = process.env.PYIDE_GH;
  if (override) return override !== 'none' && fs.existsSync(override) ? override : null;
  if (cached && fs.existsSync(cached)) return cached;
  cached = ghOnPath() || installDirs().find((p) => fs.existsSync(p)) || null;
  return cached;
}

// ---------- running programs ----------
// A .cmd/.bat (an npm-style shim, or the tests' fake gh) runs through cmd.exe, which parses the command line again:
// each argument is quoted for the C runtime and its cmd metacharacters escaped twice (once for cmd, once for the
// batch file's %*), as cross-spawn does.
const META = /([()\][%!^"`<>&|;, *?])/g;
const cmdArg = (a) => `"${String(a).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`.replace(META, '^$1').replace(META, '^$1');
function spawnTool(file, args, opts) {
  if (!/\.(cmd|bat)$/i.test(file)) return spawn(file, args, opts);
  const line = [path.normalize(file).replace(META, '^$1'), ...args.map(cmdArg)].join(' ');
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true });
}

const killTree = (p) => { if (p.exitCode === null) execFile('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }, () => {}); };

// -> {code, out, err, buf}; onData(text) gets output as it arrives.
function run(file, args, { cwd, input, onData, timeout = READ_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawnTool(file, args, { cwd: cwd || os.homedir(), env: { ...process.env, ...ENV }, windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, out: '', err: e.message });
    }
    const out = [];
    const err = [];
    const timer = setTimeout(() => { err.push(Buffer.from(`\nTimed out after ${Math.round(timeout / 1000)} s\n`)); killTree(p); }, timeout);
    p.stdout.on('data', (d) => { out.push(d); onData?.(d.toString('utf8')); });
    p.stderr.on('data', (d) => { err.push(d); onData?.(d.toString('utf8')); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: '', err: e.message }); });
    p.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      resolve({ code, buf, out: buf.toString('utf8'), err: Buffer.concat(err).toString('utf8') });
    });
    p.stdin.on('error', () => {});
    p.stdin.end(input ?? '');
  });
}

const UNTRUSTED = { code: -1, out: '', err: 'This project is not trusted', reason: 'untrusted' };
const git = (root, args) => (trust.isTrusted(root)
  ? run('git', ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], { cwd: root })
  : Promise.resolve(UNTRUSTED));

async function gh(root, args, opts = {}) {
  if (!trust.isTrusted(root)) return UNTRUSTED;
  const file = await findGh();
  if (!file) return { code: -1, out: '', err: 'GitHub CLI (gh) is not installed', reason: 'missing' };
  return run(file, args, { cwd: root, ...opts });
}

const cmdLine = (args) => `gh ${args.map((a) => (/[\s"]/.test(a) || a === '' ? `"${a}"` : a)).join(' ')}`;
const fileText = (buf) => textCodec.decode(buf, textCodec.detect(buf));
const parseJson = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

// owner/repo of a GitHub remote URL (https, ssh or scp-like), else null.
function githubRepoOf(url) {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

// Validation of what the renderer sends; gh and git get nothing that could read as an option.
const REPO_NAME = /^(?:[A-Za-z0-9][A-Za-z0-9-]*\/)?[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REF_NAME = /^(?!-)(?!.*\.\.)[^\s~^:?*[\\\x00-\x1f]{1,250}$/;
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;
const prNumber = (n) => (Number.isInteger(Number(n)) && Number(n) > 0 ? String(Number(n)) : null);

async function repoState(root) {
  if (!trust.isTrusted(root)) return { trusted: false };
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code || inside.out.trim() !== 'true') return { trusted: true, isRepo: false, remotes: [], github: null };
  const [head, urls] = await Promise.all([
    git(root, ['rev-parse', '-q', '--verify', 'HEAD']),
    git(root, ['config', '--get-regexp', '^remote\\..*\\.url$']),
  ]);
  const remotes = urls.out.split(/\r?\n/).map((l) => /^remote\.(.+)\.url (.+)$/.exec(l.trim())).filter(Boolean)
    .map(([, name, url]) => ({ name, url, ...githubRepoOf(url) }));
  const gh = remotes.filter((r) => r.owner);
  const github = gh.find((r) => r.name === 'origin') || gh[0] || null;
  if (github) github.web = `https://github.com/${github.owner}/${github.repo}`;
  return { trusted: true, isRepo: true, head: !head.code && !!head.out.trim(), remotes, github };
}

exports.register = ({ ipcMain, send }) => {
  const h = (name, fn) => ipcMain.handle(`github:${name}`, (_e, ...args) => fn(...args));
  // A long command streams its output to the renderer as github:output {op, cmd} then {op, text}.
  const streamed = (op) => (op ? (text) => send('github:output', { op, text }) : undefined);
  const announce = (op, args) => op && send('github:output', { op, cmd: cmdLine(args) });

  // Where gh is and who is logged in. Nothing runs for an untrusted project.
  h('status', async (root) => {
    if (!trust.isTrusted(root)) return { trusted: false };
    const file = await findGh();
    if (!file) return { trusted: true, installed: false };
    const ver = await run(file, ['--version']);
    if (ver.code) return { trusted: true, installed: false, path: file, error: (ver.err || ver.out).trim() };
    const auth = await run(file, ['auth', 'status']);
    const text = `${auth.out}\n${auth.err}`.trim();
    // "Logged in to github.com account octocat (keyring)" (gh 2.40+) or "Logged in to github.com as octocat" (older).
    const who = /Logged in to (\S+) (?:account|as) ([^\s()]+)/.exec(text);
    return {
      trusted: true, installed: true, path: file, version: /gh version (\S+)/.exec(ver.out)?.[1] || null,
      loggedIn: auth.code === 0, account: who?.[2] || null, host: who?.[1] || null, authText: text,
    };
  });

  h('repo', repoState);

  // gh repo create <name> --private|--public [--description <text>] --source <root> --remote <remote> --push
  h('share', async (root, opts = {}, op) => {
    const name = String(opts.name || '').trim();
    const remote = String(opts.remote || '').trim();
    const description = String(opts.description || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 350);
    if (!REPO_NAME.test(name)) return { ok: false, reason: 'badName' };
    if (!REMOTE_NAME.test(remote)) return { ok: false, reason: 'badRemote' };
    const st = await repoState(root);
    if (!st.trusted) return { ok: false, ...UNTRUSTED };
    if (!st.isRepo) return { ok: false, reason: 'notRepo' };
    if (!st.head) return { ok: false, reason: 'noCommits' };
    if (st.github) return { ok: false, reason: 'alreadyShared', url: st.github.web };
    if (st.remotes.some((r) => r.name === remote)) return { ok: false, reason: 'remoteExists', remote };
    const args = ['repo', 'create', name, opts.private === false ? '--public' : '--private',
      ...(description ? ['--description', description] : []), '--source', root, '--remote', remote, '--push'];
    announce(op, args);
    const r = await gh(root, args, { onData: streamed(op), timeout: WRITE_TIMEOUT });
    const url = /https:\/\/github\.com\/[^\s'"]+/.exec(`${r.out}\n${r.err}`)?.[0]?.replace(/\.git$/, '') || null;
    return { ok: !r.code, cmd: cmdLine(args), out: r.out, err: r.err, reason: r.reason, url };
  });

  // filter: 'open' | 'closed' | 'mine' (open pull requests the user opened, PyCharm's "Your pull requests").
  h('prList', async (root, filter = 'open') => {
    const args = ['pr', 'list', '--json', PR_LIST_FIELDS, '--limit', '50', '--state', filter === 'closed' ? 'closed' : 'open',
      ...(filter === 'mine' ? ['--author', '@me'] : [])];
    const r = await gh(root, args);
    const prs = r.code ? undefined : parseJson(r.out);
    if (!Array.isArray(prs)) return { ok: false, cmd: cmdLine(args), err: r.err || r.out, reason: r.reason || (r.code ? undefined : 'badOutput') };
    return { ok: true, cmd: cmdLine(args), prs };
  });

  h('prView', async (root, number) => {
    const n = prNumber(number);
    if (!n) return { ok: false, reason: 'badNumber' };
    const args = ['pr', 'view', n, '--json', PR_VIEW_FIELDS];
    const r = await gh(root, args);
    const pr = r.code ? undefined : parseJson(r.out);
    if (!pr || typeof pr !== 'object') return { ok: false, cmd: cmdLine(args), err: r.err || r.out, reason: r.reason || (r.code ? undefined : 'badOutput') };
    return { ok: true, cmd: cmdLine(args), pr };
  });

  // Both sides of one file of a pull request, from the local repository: the head commit and its merge base with the
  // base branch (what GitHub's "Files changed" compares). Nothing is fetched; a head commit that is not here yet
  // comes with Checkout.
  h('fileDiff', async (root, { base, head, file, remote } = {}) => {
    if (!OID.test(head || '') || !REF_NAME.test(base || '') || typeof file !== 'string' || !file || file.startsWith('-')) return { ok: false, reason: 'badInput' };
    if (!trust.isTrusted(root)) return { ok: false, ...UNTRUSTED };
    if ((await git(root, ['cat-file', '-e', `${head}^{commit}`])).code) return { ok: false, reason: 'headMissing' };
    const candidates = [...(REMOTE_NAME.test(remote || '') ? [`refs/remotes/${remote}/${base}`] : []), `refs/heads/${base}`, `refs/remotes/origin/${base}`];
    let mergeBase = null;
    for (const ref of candidates) {
      const r = await git(root, ['merge-base', ref, head]);
      if (!r.code && r.out.trim()) { mergeBase = r.out.trim(); break; }
    }
    if (!mergeBase) return { ok: false, reason: 'baseMissing', base };
    const show = async (rev) => { const r = await git(root, ['show', `${rev}:${file}`]); return r.code ? null : fileText(r.buf); };
    const [left, right] = await Promise.all([show(mergeBase), show(head)]);
    return { ok: true, base: mergeBase, left, right };
  });

  h('checkout', async (root, number, op) => {
    const n = prNumber(number);
    if (!n) return { ok: false, reason: 'badNumber' };
    const args = ['pr', 'checkout', n];
    announce(op, args);
    const r = await gh(root, args, { onData: streamed(op), timeout: WRITE_TIMEOUT });
    return { ok: !r.code, cmd: cmdLine(args), out: r.out, err: r.err, reason: r.reason };
  });

  // Pull request and check pages, and cli.github.com. PYIDE_FAKE_OPEN_EXTERNAL=1 (tests) only records the URL.
  const opened = [];
  h('openUrl', async (url) => {
    let u;
    try { u = new URL(String(url)); } catch { return false; }
    if (u.protocol !== 'https:') return false;
    opened.push(u.href);
    if (process.env.PYIDE_FAKE_OPEN_EXTERNAL !== '1') await shell.openExternal(u.href);
    return true;
  });
  h('openedUrls', () => opened);
};

exports.githubRepoOf = githubRepoOf;
exports.ghOnPath = ghOnPath;
exports.findGh = findGh;
exports.run = run;
