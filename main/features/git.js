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
      // `stash -u` cleans untracked files through a magic `:/` pathspec that literal pathspecs would disable; the
      // stash commands here take no user paths.
      const literal = args[0] === 'stash' ? [] : ['--literal-pathspecs'];
      p = spawn('git', ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...literal, ...args],
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
  const r = await git(root, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--show-prefix']);
  if (r.code) return null;
  const [top, gitDir, prefix = ''] = r.out.split(/\r?\n/);
  return { top: path.resolve(top), gitDir: path.resolve(gitDir), prefix };
}
const toAbs = (root, info, rel) => (rel.startsWith(info.prefix) ? path.join(root, rel.slice(info.prefix.length)) : path.join(info.top, rel));

// The multi-step operation stopped in the work tree, from the marker files git leaves in its directory.
function operationOf(gitDir) {
  const has = (name) => fs.existsSync(path.join(gitDir, name));
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
  if (has('MERGE_HEAD')) return 'merge';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (has('REVERT_HEAD')) return 'revert';
  return null;
}
const readGitFile = (info, name) => { try { return fs.readFileSync(path.join(info.gitDir, name), 'utf8').trim(); } catch { return ''; } };

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
  res.op = operationOf(info.gitDir);
  // A rebase detaches HEAD; the branch being rebased is what the user thinks of as current.
  if (res.op === 'rebase') res.opBranch = (readGitFile(info, 'rebase-merge/head-name') || readGitFile(info, 'rebase-apply/head-name')).replace(/^refs\/heads\//, '') || null;
  if (res.op === 'merge') res.mergeMessage = readGitFile(info, 'MERGE_MSG').split(/\r?\n/).filter((l) => !l.startsWith('#')).join('\n').trim();
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

async function conflictedPaths(root, info) {
  const r = await git(root, ['diff', '--name-only', '--diff-filter=U', '-z']);
  return [...new Set(r.out.split('\0').filter(Boolean))].map((rel) => toAbs(root, info, rel));
}

// Runs a git command that may stop on conflicts (merge, rebase, cherry-pick, revert, unstash, pull) and reports
// where it left the work tree: the files still in conflict, the operation waiting for --continue, whether HEAD moved.
async function runStoppable(root, args) {
  const before = (await git(root, ['rev-parse', '-q', '--verify', 'HEAD'])).out.trim();
  const r = await git(root, args);
  const info = await repoInfo(root);
  const after = (await git(root, ['rev-parse', '-q', '--verify', 'HEAD'])).out.trim();
  let updated = [];
  if (before && after && before !== after) {
    const d = await git(root, ['diff', '--name-only', '-z', before, after]);
    updated = d.out.split('\0').filter(Boolean).map((rel) => toAbs(root, info, rel));
  }
  return { ok: !r.code, cmd: cmdLine(args), out: r.out, err: r.err, conflicts: info ? await conflictedPaths(root, info) : [],
    op: info ? operationOf(info.gitDir) : null, moved: before !== after, updated };
}

// Short names of the branches pointing at `rev`, else its abbreviated hash.
async function nameOf(root, rev) {
  const refs = await git(root, ['for-each-ref', '--points-at', rev, '--format=%(refname:short)', 'refs/heads', 'refs/remotes']);
  const name = refs.out.split(/\r?\n/).find((n) => n && !n.endsWith('/HEAD'));
  return name || (await git(root, ['rev-parse', '--short', rev])).out.trim() || null;
}

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
    // an empty pathspec file would make `add -A` take the whole work tree
    const add = rels ? await git(root, addArgs, rels) : { code: 0 };
    if (add.code) return { ok: false, cmd: cmdLine(addArgs), out: add.out, err: add.err };
    const msgFile = path.join(os.tmpdir(), `pyide-commit-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(msgFile, message, 'utf8');
    // git refuses a partial commit while a merge, cherry-pick or rebase is stopped: that commit takes the whole index.
    const info = await repoInfo(root);
    const whole = !!(info && operationOf(info.gitDir));
    const args = whole ? ['commit', '-F', msgFile] : ['commit', '-F', msgFile, '--pathspec-from-file=-', '--pathspec-file-nul'];
    const r = await git(root, args, [...paths, ...origs].map((p) => relOf(root, p)).join('\0'));
    try { fs.unlinkSync(msgFile); } catch {}
    const hash = r.code ? null : (await git(root, ['rev-parse', '--short', 'HEAD'])).out.trim();
    const shown = ['commit', '-m', message.split('\n')[0], ...(whole ? [] : ['--', ...paths.map((p) => relOf(root, p))])];
    return { ok: !r.code, cmd: cmdLine(shown), out: r.out, err: r.err, hash };
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
    const r = await runStoppable(root, ['pull', '--no-rebase', '--no-edit']);
    return { ...r, upToDate: r.ok && !r.moved };
  });

  // ---------- merge, rebase, cherry-pick, revert and the conflicts they leave ----------
  h('merge', (root, branch) => runStoppable(root, ['merge', '--no-edit', branch]));
  h('rebase', (root, onto) => runStoppable(root, ['rebase', onto]));
  // A merge commit is picked or reverted against its first parent, as PyCharm does.
  h('cherryPick', (root, hash, isMerge) => runStoppable(root, ['cherry-pick', ...(isMerge ? ['-m', '1'] : []), hash]));
  h('revert', (root, hash, isMerge) => runStoppable(root, ['revert', '--no-edit', ...(isMerge ? ['-m', '1'] : []), hash]));

  // action: 'abort' | 'continue' | 'skip', applied to whichever operation is stopped.
  h('operation', async (root, action) => {
    const info = await repoInfo(root);
    const op = info && operationOf(info.gitDir);
    if (!op) return { ok: false, reason: 'noOperation', err: 'No merge, rebase, cherry-pick or revert is in progress.' };
    return { ...(await runStoppable(root, [op, `--${action}`])), was: op };
  });

  // Names for the two sides of the conflicts in the work tree: ours (stage 2) and theirs (stage 3).
  h('conflictSides', async (root) => {
    const info = await repoInfo(root);
    const op = info && operationOf(info.gitDir);
    const branch = (await git(root, ['branch', '--show-current'])).out.trim();
    const current = branch || (await git(root, ['rev-parse', '--short', 'HEAD'])).out.trim() || null;
    if (op === 'merge') return { op, ours: current, theirs: await nameOf(root, 'MERGE_HEAD') };
    if (op === 'rebase') {
      const rebased = (readGitFile(info, 'rebase-merge/head-name') || readGitFile(info, 'rebase-apply/head-name')).replace(/^refs\/heads\//, '');
      const onto = readGitFile(info, 'rebase-merge/onto') || readGitFile(info, 'rebase-apply/onto');
      return { op, ours: onto ? await nameOf(root, onto) : current, theirs: rebased || null };
    }
    if (op === 'cherry-pick') return { op, ours: current, theirs: await nameOf(root, 'CHERRY_PICK_HEAD') };
    if (op === 'revert') return { op, ours: current, theirs: await nameOf(root, 'REVERT_HEAD') };
    return { op: null, ours: current, theirs: null };
  });

  // The three versions of a conflicted file (null where that side has no such file) and what is on disk now.
  h('mergeVersions', async (root, abs) => {
    const rel = relOf(root, abs);
    const stage = async (n) => { const r = await git(root, ['show', `:${n}:./${rel}`]); return r.code ? null : r.out; };
    const [base, ours, theirs] = await Promise.all([stage(1), stage(2), stage(3)]);
    let working = null;
    try { working = fs.readFileSync(abs, 'utf8'); } catch {}
    return { base, ours, theirs, working };
  });

  // Marks a file resolved with `content` (null: the file is deleted), like `git add` / `git rm` after a merge tool.
  h('resolve', async (root, abs, content) => {
    const rel = relOf(root, abs);
    if (content == null) {
      const args = ['rm', '--quiet', '--', rel];
      const r = await git(root, args);
      return { ok: !r.code, cmd: cmdLine(args), out: r.out, err: r.err };
    }
    fs.writeFileSync(abs, content, 'utf8');
    const args = ['add', '--', rel];
    const r = await git(root, args);
    return { ok: !r.code, cmd: cmdLine(args), out: r.out, err: r.err };
  });

  // Accept Yours / Accept Theirs: each file becomes that side's version, or is removed where that side deleted it.
  h('acceptSide', async (root, files, side) => {
    const log = [];
    let ok = true;
    const run = async (args) => {
      const r = await git(root, args);
      log.push({ cmd: cmdLine(args), out: r.out, err: r.err });
      if (r.code) ok = false;
      return r;
    };
    for (const abs of files) {
      const rel = relOf(root, abs);
      const stages = (await git(root, ['ls-files', '-u', '--', rel])).out.split(/\r?\n/).filter(Boolean).map((l) => l.split(/\s+/)[2]);
      if (stages.includes(side === 'ours' ? '2' : '3')) {
        if (!(await run(['checkout', `--${side}`, '--', rel])).code) await run(['add', '--', rel]);
      } else await run(['rm', '--quiet', '--', rel]);
    }
    return { ok, log };
  });

  // ---------- stash ----------
  h('stashList', async (root) => {
    const r = await git(root, ['stash', 'list', '--format=%gd%x1f%H%x1f%ct%x1f%gs%x1e']);
    if (r.code) return [];
    return r.out.split('\x1e').map((s) => s.trim()).filter(Boolean).map((rec) => {
      const [ref, hash, time, subject] = rec.split('\x1f');
      // git writes "On <branch>: <message>" for a named stash and "WIP on <branch>: <hash> <subject>" otherwise.
      const m = /^(?:WIP on|On) (.+?): (.*)$/s.exec(subject);
      return { ref, hash, time: Number(time), subject, branch: m?.[1] || null, message: m?.[2] ?? subject };
    });
  });

  h('stash', async (root, { message, untracked, keepIndex } = {}) => {
    const args = ['stash', 'push', ...(untracked ? ['--include-untracked'] : []), ...(keepIndex ? ['--keep-index'] : []), ...(message ? ['-m', message] : [])];
    const r = await git(root, args);
    const nothing = !r.code && /No local changes to save/.test(r.out);
    return { ok: !r.code && !nothing, cmd: cmdLine(args), out: r.out, err: r.err, ...(nothing ? { reason: 'noLocalChanges' } : {}) };
  });

  // opts: {pop, index, branch}. With a branch name the stash is applied onto a new branch made where it was created.
  h('unstash', (root, ref, { pop, index, branch } = {}) => runStoppable(root, branch
    ? ['stash', 'branch', branch, ref]
    : ['stash', pop ? 'pop' : 'apply', ...(index ? ['--index'] : []), ref]));

  h('stashDrop', async (root, ref) => {
    const args = ['stash', 'drop', ref];
    const r = await git(root, args);
    return { ok: !r.code, cmd: cmdLine(args), out: r.out, err: r.err };
  });

  // Files a stash changes, untracked ones included; their content is at <ref>^1 (before) and <ref> or <ref>^3 (after).
  h('stashFiles', async (root, ref) => {
    const info = await repoInfo(root);
    const r = await git(root, ['stash', 'show', '--include-untracked', '--name-status', '--no-renames', '-z', ref]);
    const parts = r.out.split('\0').filter(Boolean);
    const list = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const s = parts[i][0];
      list.push({ status: s === 'A' ? 'added' : s === 'D' ? 'deleted' : 'modified', rel: parts[i + 1], path: info ? toAbs(root, info, parts[i + 1]) : parts[i + 1] });
    }
    return list;
  });
};
