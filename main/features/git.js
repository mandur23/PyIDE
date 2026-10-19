// Git integration: every operation shells out to the git CLI in the project folder.
// Errors composed here carry a `reason` the renderer translates; git's own output is passed through untranslated.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// No credential/editor prompts can be answered from the IDE, so fail fast instead of hanging.
const ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_EDITOR: 'true', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };

function git(cwd, args, input) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn('git', ['-c', 'core.quotepath=false', '-c', 'color.ui=false', '--literal-pathspecs', ...args],
        { cwd, env: { ...process.env, ...ENV }, windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, out: '', err: e.message });
    }
    const out = [];
    const err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', (e) => resolve({ code: -1, out: '', err: e.message }));
    p.on('close', (code) => resolve({ code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8') }));
    p.stdin.on('error', () => {});
    p.stdin.end(input ?? '');
  });
}

const cmdLine = (args) => `git ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
const relOf = (root, abs) => path.relative(root, abs).replace(/\\/g, '/');

// The project may be a subfolder of the work tree; map repo-relative paths through the prefix so
// returned paths keep the exact spelling of `root` (temp dirs can differ in 8.3/long form).
async function repoInfo(root) {
  const r = await git(root, ['rev-parse', '--show-toplevel', '--show-prefix']);
  if (r.code) return null;
  const [top, prefix = ''] = r.out.split(/\r?\n/);
  return { top: path.resolve(top), prefix };
}
const toAbs = (root, info, rel) => (rel.startsWith(info.prefix) ? path.join(root, rel.slice(info.prefix.length)) : path.join(info.top, rel));

const STATUS_OF = (xy) => {
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'conflict';
  if (xy[0] === 'D' || xy[1] === 'D') return 'deleted';
  if (xy[0] === 'A') return 'added';
  return 'modified';
};

async function status(root) {
  const info = await repoInfo(root);
  if (!info) return { isRepo: false };
  const [st, remotes] = await Promise.all([
    git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
    git(root, ['remote']),
  ]);
  const res = { isRepo: true, top: info.top, branch: null, head: null, upstream: null, ahead: 0, behind: 0, files: [],
    remotes: remotes.out.split(/\r?\n/).filter(Boolean) };
  const parts = st.out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) res.head = line.slice(13) === '(initial)' ? null : line.slice(13);
    else if (line.startsWith('# branch.head ')) res.branch = line.slice(14) === '(detached)' ? null : line.slice(14);
    else if (line.startsWith('# branch.upstream ')) res.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) [res.ahead, res.behind] = line.slice(12).split(' ').map((n) => Math.abs(Number(n)));
    else if (line.startsWith('? ')) res.files.push({ status: 'unversioned', rel: line.slice(2) });
    else if (line.startsWith('1 ')) {
      const f = line.split(' ');
      res.files.push({ status: STATUS_OF(f[1]), xy: f[1], rel: f.slice(8).join(' ') });
    } else if (line.startsWith('2 ')) {
      const f = line.split(' ');
      const orig = parts[++i];
      res.files.push({ status: 'modified', xy: f[1], rel: f.slice(9).join(' '), orig: toAbs(root, info, orig) });
    } else if (line.startsWith('u ')) {
      res.files.push({ status: 'conflict', xy: line.split(' ')[1], rel: line.split(' ').slice(10).join(' ') });
    }
  }
  for (const f of res.files) f.path = toAbs(root, info, f.rel);
  if (res.head && !res.branch) res.detached = res.head.slice(0, 8);
  return res;
}

function parseBlame(out) {
  const lines = [];
  const commits = {};
  let cur = null;
  let final = 0;
  for (const line of out.split('\n')) {
    const h = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (h) { cur = h[1]; final = Number(h[2]); commits[cur] ||= { hash: cur }; continue; }
    if (!cur) continue;
    if (line.startsWith('\t')) lines[final - 1] = cur;
    else if (line.startsWith('author ')) commits[cur].author = line.slice(7);
    else if (line.startsWith('author-time ')) commits[cur].time = Number(line.slice(12));
    else if (line.startsWith('summary ')) commits[cur].summary = line.slice(8);
  }
  return { lines, commits };
}

const pickRemote = (remotes) => (remotes.includes('origin') ? 'origin' : remotes[0]);

exports.register = ({ ipcMain }) => {
  const h = (name, fn) => ipcMain.handle(`git:${name}`, (_e, ...args) => fn(...args));

  h('status', status);

  h('init', async (root) => {
    const r = await git(root, ['init']);
    return { ok: !r.code, cmd: cmdLine(['init']), out: r.out, err: r.err };
  });

  h('branches', async (root) => {
    const r = await git(root, ['for-each-ref', '--format=%(refname)%09%(refname:short)', 'refs/heads', 'refs/remotes']);
    const local = [];
    const remote = [];
    for (const line of r.out.split(/\r?\n/).filter(Boolean)) {
      const [full, short] = line.split('\t');
      if (full.endsWith('/HEAD')) continue;
      (full.startsWith('refs/heads/') ? local : remote).push(short);
    }
    return { local, remote };
  });

  h('checkout', async (root, branch, track) => {
    const args = track ? ['checkout', '--track', branch] : ['checkout', branch];
    const r = await git(root, args);
    return { ok: !r.code, cmd: cmdLine(args), out: r.out, err: r.err };
  });

  h('newBranch', async (root, name) => {
    const args = ['checkout', '-b', name];
    const r = await git(root, args);
    return { ok: !r.code, cmd: cmdLine(args), out: r.out, err: r.err };
  });

  // Content of a project file at `rev` (null when the file does not exist there).
  h('show', async (root, abs, rev = 'HEAD') => {
    const r = await git(root, ['show', `${rev}:./${relOf(root, abs)}`]);
    return r.code ? null : r.out;
  });

  // Content of a repo-relative path at `rev`, for diffs of historical commits.
  h('fileAt', async (root, rev, repoRel) => {
    const info = await repoInfo(root);
    const r = await git(info?.top || root, ['show', `${rev}:${repoRel}`]);
    return r.code ? null : r.out;
  });

  // files: [path | {path, orig}]. A staged rename's original path is committed too (its deletion is already staged and
  // `git commit <paths>` implies --only), but is not passed to `git add`, which rejects a path gone from index and disk.
  h('commit', async (root, message, files) => {
    const paths = files.map((f) => (typeof f === 'string' ? f : f.path));
    const origs = files.map((f) => (typeof f === 'string' ? null : f.orig)).filter(Boolean);
    const rels = paths.map((p) => relOf(root, p)).join('\0');
    const addArgs = ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'];
    const add = await git(root, addArgs, rels);
    if (add.code) return { ok: false, cmd: cmdLine(addArgs), out: add.out, err: add.err };
    const msgFile = path.join(os.tmpdir(), `pyide-commit-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(msgFile, message, 'utf8');
    const args = ['commit', '-F', msgFile, '--pathspec-from-file=-', '--pathspec-file-nul'];
    const r = await git(root, args, [...paths, ...origs].map((p) => relOf(root, p)).join('\0'));
    try { fs.unlinkSync(msgFile); } catch {}
    const hash = r.code ? null : (await git(root, ['rev-parse', '--short', 'HEAD'])).out.trim();
    return { ok: !r.code, cmd: cmdLine(['commit', '-m', message.split('\n')[0], '--', ...paths.map((p) => relOf(root, p))]), out: r.out, err: r.err, hash };
  });

  // files: [{path, status}]. Tracked changes are restored from HEAD; newly added files are only unstaged.
  h('rollback', async (root, files) => {
    const log = [];
    let ok = true;
    const run = async (args, list) => {
      if (!list.length) return;
      const r = await git(root, args, list.map((f) => relOf(root, f.path)).join('\0'));
      log.push({ cmd: cmdLine(args), out: r.out, err: r.err });
      if (r.code) ok = false;
    };
    const added = files.filter((f) => f.status === 'added');
    const tracked = files.filter((f) => ['modified', 'deleted', 'conflict'].includes(f.status) && !f.orig);
    const renamed = files.filter((f) => f.orig);
    await run(['restore', '--source=HEAD', '--staged', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'],
      [...tracked, ...renamed.map((f) => ({ path: f.orig }))]);
    await run(['rm', '--cached', '--quiet', '--pathspec-from-file=-', '--pathspec-file-nul'], [...added, ...renamed]);
    return { ok, log };
  });

  h('log', async (root, max = 1000) => {
    const r = await git(root, ['log', '--all', '--date-order', `-n${max}`, '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D%x1f%P%x1e']);
    if (r.code) return [];
    return r.out.split('\x1e').map((s) => s.trim()).filter(Boolean).map((rec) => {
      const [hash, short, author, email, time, subject, refs, parents] = rec.split('\x1f');
      return { hash, short, author, email, time: Number(time), subject, refs: refs ? refs.split(', ') : [], parents: parents ? parents.split(' ') : [] };
    });
  });

  // What happened to HEAD, newest first: commits, merges, checkouts, pulls, resets, rebases. `action` is git's own
  // reflog subject ("merge feature: Fast-forward"); the renderer classifies it.
  h('reflog', async (root, max = 300) => {
    const r = await git(root, ['reflog', 'show', '--date=unix', `-n${max}`, '--format=%H%x1f%h%x1f%gd%x1f%gs%x1f%gn%x1f%s%x1e', 'HEAD']);
    if (r.code) return [];
    return r.out.split('\x1e').map((s) => s.trim()).filter(Boolean).map((rec) => {
      const [hash, short, selector, action, who, subject] = rec.split('\x1f');
      return { hash, short, time: Number(/\{(\d+)\}/.exec(selector)?.[1]) || 0, action, who, subject };
    });
  });

  h('identity', async (root) => {
    const [name, email] = await Promise.all([git(root, ['config', 'user.name']), git(root, ['config', 'user.email'])]);
    return { name: name.out.trim(), email: email.out.trim() };
  });

  h('commitDetails', async (root, hash) => {
    const info = await repoInfo(root);
    const [files, msg] = await Promise.all([
      git(root, ['diff-tree', '-r', '--root', '--no-commit-id', '--name-status', '--no-renames', '-z', '--diff-merges=first-parent', hash]),
      git(root, ['show', '-s', '--format=%H%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%B', hash]),
    ]);
    const parts = files.out.split('\0').filter(Boolean);
    const list = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const s = parts[i][0];
      list.push({ status: s === 'A' ? 'added' : s === 'D' ? 'deleted' : 'modified', rel: parts[i + 1], path: info ? toAbs(root, info, parts[i + 1]) : parts[i + 1] });
    }
    const [full, author, email, time, parents, ...body] = msg.out.split('\x1f');
    return { hash: full, author, email, time: Number(time), parents: parents ? parents.split(' ') : [], message: body.join('\x1f').trim(), files: list };
  });

  h('blame', async (root, abs, content) => {
    const r = await git(root, ['blame', '--porcelain', '--contents', '-', '--', relOf(root, abs)], content);
    return r.code ? null : parseBlame(r.out);
  });

  h('addRemote', async (root, name, url) => {
    const args = ['remote', 'add', name, url];
    const r = await git(root, args);
    return { ok: !r.code, cmd: cmdLine(args), out: r.out, err: r.err };
  });

  // What Push would send: the remote/branch pair and the commits not yet on it.
  h('outgoing', async (root) => {
    const st = await status(root);
    if (!st.isRepo) return { remotes: [] };
    const remote = st.upstream ? st.upstream.split('/')[0] : pickRemote(st.remotes);
    const range = st.upstream ? ['@{u}..HEAD'] : ['HEAD', '--not', '--remotes'];
    const r = st.head ? await git(root, ['log', '--format=%h%x1f%s%x1f%an', ...range]) : { out: '' };
    const commits = r.out.split(/\r?\n/).filter(Boolean).map((l) => { const [short, subject, author] = l.split('\x1f'); return { short, subject, author }; });
    return { remotes: st.remotes, remote, branch: st.branch, upstream: st.upstream, commits };
  });

  h('push', async (root) => {
    const st = await status(root);
    if (!st.isRepo) return { ok: false, reason: 'notRepo', err: 'Not a Git repository' };
    if (!st.remotes.length) return { ok: false, noRemote: true, reason: 'noRemote', err: 'No remotes are defined for this repository.' };
    if (!st.branch) return { ok: false, reason: 'detached', err: 'Cannot push from a detached HEAD.' };
    const count = await git(root, ['rev-list', '--count', ...(st.upstream ? ['@{u}..HEAD'] : ['HEAD', '--not', '--remotes'])]);
    const args = st.upstream ? ['push', '--porcelain'] : ['push', '--porcelain', '-u', pickRemote(st.remotes), st.branch];
    const r = await git(root, args);
    return { ok: !r.code, cmd: cmdLine(args), out: r.out, err: r.err, pushed: Number(count.out.trim()) || 0,
      target: st.upstream || `${pickRemote(st.remotes)}/${st.branch}` };
  });

  h('pull', async (root) => {
    const st = await status(root);
    if (!st.isRepo) return { ok: false, reason: 'notRepo', err: 'Not a Git repository' };
    if (!st.remotes.length) return { ok: false, noRemote: true, reason: 'noRemote', err: 'No remotes are defined for this repository.' };
    const before = st.head;
    const args = ['pull', '--no-rebase', '--no-edit'];
    const r = await git(root, args);
    const after = (await git(root, ['rev-parse', 'HEAD'])).out.trim();
    let updated = [];
    if (!r.code && before && after && before !== after) {
      const info = await repoInfo(root);
      const d = await git(root, ['diff', '--name-only', '-z', before, after]);
      updated = d.out.split('\0').filter(Boolean).map((rel) => toAbs(root, info, rel));
    }
    return { ok: !r.code, cmd: cmdLine(args), out: r.out, err: r.err, updated, upToDate: !r.code && before === after };
  });
};
