// Git integration: every operation shells out to the git CLI in the project folder.
// Errors composed here carry a `reason` the renderer translates; git's own output is passed through untranslated.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const textCodec = require('../text-codec');
const trust = require('../trust');

// No credential/editor prompts can be answered from the IDE, so fail fast instead of hanging.
const ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_EDITOR: 'true', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };

// git.exe not found on PATH: every operation then fails with reason gitMissing, which the renderer translates.
const missing = (e) => (e.code === 'ENOENT' ? { reason: 'gitMissing' } : {});

// env: extra variables for this one command (the shelf builds its patches in a private GIT_INDEX_FILE).
// opts.timeout: milliseconds after which the command is killed (the result then has `timedOut`).
// opts.onSpawn(child): the started process, for a caller that must be able to kill it (backgroundFetch).
function git(cwd, args, input, env, opts = {}) {
  // A repository's own .git/config can make even `git status` run programs (core.fsmonitor, filter.*.clean), so
  // git does not run in a project the user has not trusted (main/trust.js).
  if (!trust.isTrusted(cwd)) return Promise.resolve({ code: -1, out: '', err: 'This project is not trusted', reason: 'untrusted' });
  return new Promise((resolve) => {
    let p;
    try {
      // `stash -u` cleans untracked files through a magic `:/` pathspec that literal pathspecs would disable; the
      // stash commands here take no user paths.
      const literal = args[0] === 'stash' ? [] : ['--literal-pathspecs'];
      p = spawn('git', ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...literal, ...args],
        { cwd, env: { ...process.env, ...ENV, ...env }, windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, out: '', err: e.message, ...missing(e) });
    }
    opts.onSpawn?.(p);
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = opts.timeout ? setTimeout(() => { timedOut = true; try { p.kill(); } catch {} }, opts.timeout) : null;
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: '', err: e.message, ...missing(e) }); });
    p.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      resolve({ code, buf, out: buf.toString('utf8'), err: Buffer.concat(err).toString('utf8'), ...(timedOut ? { timedOut } : {}) });
    });
    p.stdin.on('error', () => {});
    p.stdin.end(input ?? '');
  });
}

// File content as the editor reads it (main/text-codec.js): Korean Windows files are often CP949, and a UTF-8 BOM
// is not part of the text. Decoding it as UTF-8 marked every Korean line as changed and broke merges of such files.
const fileText = (buf) => textCodec.decode(buf, textCodec.detect(buf));
// The encoding of a work tree file as it is on disk (UTF-8 when it cannot be read).
const diskEncoding = (abs) => { try { return textCodec.detect(fs.readFileSync(abs)); } catch { return 'utf-8'; } };

const cmdLine = (args) => `git ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
const relOf = (root, abs) => path.relative(root, abs).replace(/\\/g, '/');

// The project may be a subfolder of the work tree; map repo-relative paths through the prefix so
// returned paths keep the exact spelling of `root` (temp dirs can differ in 8.3/long form).
// -> {info} for a repository, else {failed: git's result}.
async function probeRepo(root) {
  const r = await git(root, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--show-prefix']);
  if (r.code) return { failed: r };
  const [top, gitDir, prefix = ''] = r.out.split(/\r?\n/);
  return { info: { top: path.resolve(top), gitDir: path.resolve(gitDir), prefix } };
}
const repoInfo = async (root) => (await probeRepo(root)).info || null;

// Why a project is not shown as a repository: {isRepo: false, reason?}. Git missing, and a .git in the project or a
// folder above it that git refuses (a damaged HEAD, a repository owned by another user), are not "no repository":
// offering Create Git Repository there failed, or would put a new repository over the user's history.
function notRepo(root, r) {
  if (r.reason === 'gitMissing') return { isRepo: false, reason: 'gitMissing' };
  if (r.reason) return { isRepo: false };
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      const error = (r.err || r.out).split(/\r?\n/).find((l) => /^(fatal|error):/.test(l)) || (r.err || r.out).trim();
      return { isRepo: false, reason: 'damaged', top: dir, error: error.replace(/^(fatal|error):\s*/, '') };
    }
    if (path.dirname(dir) === dir) return { isRepo: false };
  }
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
  const { info, failed } = await probeRepo(root);
  if (!info) return notRepo(root, failed);
  const [st, remotes] = await Promise.all([
    // --ignored=matching lists an ignored folder once ("build/") instead of every file in it.
    git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignored=matching']),
    git(root, ['remote']),
  ]);
  const res = { isRepo: true, top: info.top, branch: null, head: null, upstream: null, ahead: 0, behind: 0, files: [], ignored: [],
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
    else if (line.startsWith('! ') && res.ignored.length < 20000) res.ignored.push(toAbs(root, info, line.slice(2).replace(/\/$/, '')));
    else if (line.startsWith('1 ')) {
      const f = line.split(' ');
      res.files.push({ status: STATUS_OF(f[1]), xy: f[1], rel: f.slice(8).join(' ') });
    } else if (line.startsWith('2 ')) {
      const f = line.split(' ');
      const orig = parts[++i];
      res.files.push({ status: 'modified', xy: f[1], rel: f.slice(9).join(' '), orig: toAbs(root, info, orig), origRel: orig });
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

// ---------- shelf ----------
// PyCharm's shelf: named sets of changes put aside without committing. A shelf is a folder
// <userData>/shelf/<project id>/<shelf id>/ holding changes.patch, a `git diff --binary --full-index` of the shelved
// files against HEAD (untracked files as new files), and shelf.json. PyCharm keeps shelves in .idea/shelf; PyIDE has
// no .idea folder, and a shelf inside the work tree would show up as a change and could be committed or cleaned away.
let shelfRoot = null;
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
// The same project opened through an 8.3 short path or another letter case keeps its shelves.
function projectId(root) {
  let p = path.resolve(root);
  try { p = fs.realpathSync.native(p); } catch {}
  return sha1(p.toLowerCase()).slice(0, 16);
}
const shelfDir = (root, id) => {
  if (!/^[0-9a-z-]{1,40}$/.test(String(id))) throw new Error(`Bad shelf id: ${id}`);
  return path.join(shelfRoot, projectId(root), id);
};
const SHELF_META = 'shelf.json';
const SHELF_PATCH = 'changes.patch';
// Commands on paths relative to the work tree's top, whatever folder of it the project is.
const atTop = (info, args) => ['-C', info.top, ...args];
// CR line ends and trailing blanks are content here, not whitespace errors to refuse (apply.whitespace=error).
const APPLY = ['apply', '--whitespace=nowarn'];
const PATCH_ARGS = ['--no-ext-diff', '--no-textconv', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', '-M'];

// One `diff --git` section per file. "diff --git " starts a line only at a section start: hunk lines start with
// ' ', '+', '-' or '\', and the base85 lines of a binary patch have no spaces.
function splitPatch(buf) {
  const marker = Buffer.from('diff --git ');
  const starts = [];
  for (let i = buf.indexOf(marker); i !== -1; i = buf.indexOf(marker, i + 1)) if (i === 0 || buf[i - 1] === 10) starts.push(i);
  return starts.map((s, k) => buf.subarray(s, k + 1 < starts.length ? starts[k + 1] : buf.length));
}

// `--name-status -z`: "M\0path\0", and "R100\0old\0new\0" for a rename.
function parseNameStatus(out) {
  const parts = out.split('\0');
  const list = [];
  for (let i = 0; i < parts.length && parts[i];) {
    const code = parts[i++][0];
    if (code === 'R' || code === 'C') list.push({ code, orig: parts[i++], rel: parts[i++] });
    else list.push({ code, rel: parts[i++] });
  }
  return list;
}
// `--numstat -z`: "1\t2\tpath\0", "1\t2\t\0old\0new\0" for a rename, "-\t-\t…" for a binary file.
function parseBinary(out) {
  const parts = out.split('\0');
  const list = [];
  for (let i = 0; i < parts.length && parts[i];) {
    const head = parts[i++];
    list.push(head.startsWith('-\t-\t'));
    if (/^[-\d]+\t[-\d]+\t$/.test(head)) i += 2;
  }
  return list;
}
const CHANGE_STATUS = { A: 'added', C: 'added', D: 'deleted', R: 'renamed' };

function readShelf(root, id) {
  const dir = shelfDir(root, id);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, SHELF_META), 'utf8'));
  const sections = splitPatch(fs.readFileSync(path.join(dir, SHELF_PATCH)));
  if (sections.length !== meta.files.length) throw new Error(`The shelf "${meta.name}" is damaged: its patch does not match its file list.`);
  return { dir, meta, sections };
}

function writeShelf(dir, meta, sections) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SHELF_PATCH), Buffer.concat(sections));
  // the file list last: a folder without one is not listed
  fs.writeFileSync(path.join(dir, SHELF_META), JSON.stringify(meta, null, 1));
}

function listShelves(root) {
  const base = path.join(shelfRoot, projectId(root));
  let names = [];
  try { names = fs.readdirSync(base); } catch {}
  const list = [];
  for (const id of names) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(base, id, SHELF_META), 'utf8'));
      list.push({ id, name: meta.name, time: meta.time, branch: meta.branch || null, files: meta.files });
    } catch {}
  }
  return list.sort((a, b) => b.time - a.time);
}

// A private index, so building a shelf or reading one never touches what the user staged.
function tempIndex() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyide-shelf-'));
  return { dir, env: { GIT_INDEX_FILE: path.join(dir, 'index') }, file: (name, buf) => { const p = path.join(dir, name); fs.writeFileSync(p, buf); return p; },
    dispose: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

// Which repo-relative paths exist in `rev`; null when git could not tell (the command failed, or did not answer one
// line per path), which callers must not read as "none of them".
async function existingAt(root, info, rev, rels) {
  if (!rels.length) return new Set();
  const r = await git(root, atTop(info, ['cat-file', '--batch-check']), rels.map((rel) => `${rev}:${rel}\n`).join(''));
  const lines = r.out.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (r.code || lines.length !== rels.length || lines.some((l) => !l)) return null;
  return new Set(rels.filter((_rel, i) => !lines[i].endsWith(' missing')));
}

// Puts the shelved files (shelf.json entries) back to HEAD in the index and the work tree; paths HEAD lacks are
// deleted. Deleting is only safe for a file the patch holds in full: a new file, or a rename's new name (its old one
// comes back from HEAD). Any other path that seems to be missing from HEAD means git answered wrongly, and nothing is
// touched. Stops at the first step that fails. Returns null when done, else the error.
async function revertPaths(root, info, files, log) {
  const rels = [...new Set(files.flatMap((f) => (f.orig ? [f.rel, f.orig] : [f.rel])))];
  const whole = new Set(files.filter((f) => f.status === 'added' || f.orig).map((f) => f.rel));
  const head = (await git(root, ['rev-parse', '-q', '--verify', 'HEAD'])).out.trim();
  const inHead = head ? await existingAt(root, info, 'HEAD', rels) : new Set();
  if (!inHead) return 'Git could not tell which of the shelved files are in HEAD, so they were left as they are.';
  const restore = rels.filter((r) => inHead.has(r));
  const remove = rels.filter((r) => !inHead.has(r));
  const unsure = remove.filter((r) => !whole.has(r));
  if (unsure.length) return `Git reports these shelved files as missing from HEAD although the shelf holds only their changes, so nothing was rolled back: ${unsure.join(', ')}`;
  const run = async (args, list) => {
    if (!list.length) return null;
    const r = await git(root, atTop(info, args), list.join('\0'));
    log.push({ cmd: cmdLine(args.filter((a) => !a.startsWith('--pathspec'))), out: r.out, err: r.err });
    return r.code ? (r.err || r.out || `${cmdLine(args)} failed`).trim() : null;
  };
  const failed = await run(['restore', '--source=HEAD', '--staged', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], restore)
    || await run(['rm', '--cached', '--quiet', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], remove);
  if (failed) return failed;
  const errors = [];
  for (const rel of remove) {
    const abs = path.join(info.top, rel);
    try { fs.unlinkSync(abs); } catch (err) { if (err.code !== 'ENOENT') errors.push(err.message); }
    // folders the shelved files were alone in go too, as PyCharm leaves no empty package behind
    for (let dir = path.dirname(abs); dir.length > info.top.length && dir.startsWith(info.top); dir = path.dirname(dir)) {
      try { fs.rmdirSync(dir); } catch { break; }
    }
  }
  return errors.length ? errors.join('\n') : null;
}

// paths: the changed files (absolute, as git:status lists them) to shelve; keep: leave them changed in the work tree.
async function shelve(root, { name, paths, keep }) {
  const info = await repoInfo(root);
  if (!info) return { ok: false, reason: 'notRepo', err: 'Not a Git repository' };
  const st = await status(root);
  const want = new Set((paths || []).map((p) => path.resolve(p).toLowerCase()));
  const files = st.files.filter((f) => f.status !== 'conflict' && want.has(path.resolve(f.path).toLowerCase()));
  if (!files.length) return { ok: false, reason: 'noShelfChanges', err: 'No changes to shelve' };
  const rels = [...new Set(files.flatMap((f) => (f.origRel ? [f.rel, f.origRel] : [f.rel])))];
  const idx = tempIndex();
  const log = [];
  try {
    const head = (await git(root, ['rev-parse', '-q', '--verify', 'HEAD'])).out.trim();
    const step = async (args, input) => {
      const r = await git(root, atTop(info, args), input, idx.env);
      if (r.code) throw Object.assign(new Error(r.err || r.out), { git: r, cmd: cmdLine(args) });
      return r;
    };
    // HEAD plus the work tree state of exactly these paths: their diff from HEAD is the shelf.
    await step(head ? ['read-tree', 'HEAD'] : ['read-tree', '--empty']);
    await step(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], rels.join('\0'));
    const [patch, names, nums] = await Promise.all([
      step(['diff', '--cached', ...PATCH_ARGS, '--binary', '--full-index']),
      step(['diff', '--cached', ...PATCH_ARGS, '--name-status', '-z']),
      step(['diff', '--cached', ...PATCH_ARGS, '--numstat', '-z']),
    ]);
    const entries = parseNameStatus(names.out);
    const binary = parseBinary(nums.out);
    const sections = splitPatch(patch.buf);
    if (!entries.length) return { ok: false, reason: 'noShelfChanges', err: 'No changes to shelve' };
    if (sections.length !== entries.length) return { ok: false, err: 'git diff returned a patch PyIDE cannot split into files.' };
    const byRel = new Map(st.files.map((f) => [f.rel, f]));
    const meta = {
      version: 1, name: String(name || '').trim() || 'Shelved changes', time: Date.now(), branch: st.branch || st.detached || null, head: head || null,
      files: entries.map((e, i) => {
        const f = byRel.get(e.rel);
        return { rel: e.rel, ...(e.orig ? { orig: e.orig } : {}), status: CHANGE_STATUS[e.code] || 'modified', binary: binary[i] || false,
          // added to the index before shelving (git add, or a staged rename): staged again when unshelved
          staged: !!f && (f.status === 'added' || !!f.origRel) };
      }),
    };
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const dir = shelfDir(root, id);
    writeShelf(dir, meta, sections);
    let reverted = false;
    let revertError = null;
    if (!keep) {
      // Only when the patch undoes cleanly is it safe to drop the changes from the work tree: reversing a new file's
      // section checks the file on disk is byte for byte the shelved one (a binary one by its full-index hash).
      const check = await git(root, atTop(info, [...APPLY, '-R', '--check', path.join(dir, SHELF_PATCH)]));
      if (check.code) revertError = check.err || check.out || 'git apply -R --check failed';
      else {
        revertError = await revertPaths(root, info, meta.files, log);
        reverted = !revertError;
      }
    }
    return { ok: true, id, name: meta.name, files: meta.files.length, reverted, revertError,
      paths: meta.files.flatMap((f) => (f.orig ? [f.rel, f.orig] : [f.rel])).map((rel) => toAbs(root, info, rel)), log };
  } catch (err) {
    return { ok: false, cmd: err.cmd || '', out: err.git?.out || '', err: err.message, log };
  } finally {
    idx.dispose();
  }
}

// rels: the shelved files (repo-relative, as shelf.json lists them) to apply, or null for all; remove: drop the files
// that applied cleanly from the shelf (the shelf goes when none are left); files with conflicts always stay.
async function unshelve(root, id, { rels = null, remove = true } = {}) {
  const info = await repoInfo(root);
  if (!info) return { ok: false, reason: 'notRepo', err: 'Not a Git repository' };
  let shelf;
  try { shelf = readShelf(root, id); } catch (err) { return { ok: false, err: err.message }; }
  const { dir, meta, sections } = shelf;
  const pick = meta.files.map((f, i) => ({ f, sec: sections[i], i })).filter((x) => !rels || rels.includes(x.f.rel));
  if (!pick.length) return { ok: false, reason: 'noShelfChanges', err: 'No changes to shelve' };
  const tmp = tempIndex();
  const log = [];
  const run = async (args, input) => {
    const r = await git(root, atTop(info, args), input);
    log.push({ cmd: cmdLine(args.map((a) => (a.startsWith(tmp.dir) ? path.basename(a) : a))), out: r.out, err: r.err, ok: !r.code });
    return r;
  };
  const pathsOf = (x) => (x.f.orig ? [x.f.rel, x.f.orig] : [x.f.rel]);
  const applied = [];
  const conflicts = [];
  const failed = [];
  try {
    // Whatever applies to the work tree as it is goes in first, in one step and without touching the index.
    let clean = pick;
    let rest = [];
    if ((await git(root, atTop(info, [...APPLY, '--check', tmp.file('all.patch', Buffer.concat(pick.map((x) => x.sec)))]))).code) {
      clean = [];
      for (const x of pick) ((await git(root, atTop(info, [...APPLY, '--check', tmp.file(`check-${x.i}.patch`, x.sec)]))).code ? rest : clean).push(x);
    }
    if (clean.length) {
      const r = await run([...APPLY, tmp.file('clean.patch', Buffer.concat(clean.map((x) => x.sec)))]);
      if (r.code) rest = [...clean, ...rest];
      else applied.push(...clean);
    }
    // The rest is merged three ways (base: the shelved files' HEAD version). git apply --3way needs the index to
    // match the work tree for these paths; a file that merges cleanly or not at all gets its index entry back, and
    // one with conflicts is left unmerged in the index for the Conflicts dialog, as a conflicting unstash is.
    const zero = '0'.repeat(40);
    for (const x of rest) {
      const paths = pathsOf(x);
      const saved = (await git(root, atTop(info, ['ls-files', '-s', '-z', '--', ...paths]))).out.split('\0').filter(Boolean);
      const savedPaths = new Set(saved.map((l) => l.slice(l.indexOf('\t') + 1)));
      const restoreIndex = () => git(root, atTop(info, ['update-index', '-z', '--index-info']),
        [...paths.filter((p) => !savedPaths.has(p)).map((p) => `0 ${zero}\t${p}`), ...saved].map((l) => `${l}\0`).join(''));
      await git(root, atTop(info, ['add', '-A', '--', ...paths]));
      const r = await run([...APPLY, '--3way', tmp.file(`merge-${x.i}.patch`, x.sec)]);
      const unmerged = (await git(root, atTop(info, ['ls-files', '-u', '-z', '--', ...paths]))).out;
      if (unmerged) conflicts.push(x);
      else {
        await restoreIndex();
        if (r.code) failed.push({ x, err: (r.err || r.out).trim() });
        else applied.push(x);
      }
    }
    const staged = applied.filter((x) => x.f.staged).flatMap(pathsOf);
    if (staged.length) await run(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], staged.join('\0'));
  } finally {
    tmp.dispose();
  }
  let shelfRemoved = false;
  if (remove) {
    // Only files that applied cleanly leave the shelf. A file with conflicts stays, as in PyCharm: resolving it with
    // "Accept Yours" (or aborting) drops the shelved change from the work tree, and the shelf is then its only copy.
    const done = new Set(applied.map((x) => x.i));
    const left = meta.files.map((f, i) => ({ f, sec: sections[i], i })).filter((x) => !done.has(x.i));
    if (!left.length) { fs.rmSync(dir, { recursive: true, force: true }); shelfRemoved = true; }
    else if (done.size) writeShelf(dir, { ...meta, files: left.map((x) => x.f) }, left.map((x) => x.sec));
  }
  const abs = (x) => toAbs(root, info, x.f.rel);
  return {
    ok: !failed.length && !conflicts.length, applied: applied.map(abs), conflicts: conflicts.map(abs),
    // the files with conflicts that are still on the shelf (all of them, whether or not `remove` was asked for)
    keptConflicts: conflicts.map((x) => x.f.rel),
    failed: failed.map((e) => ({ path: abs(e.x), rel: e.x.f.rel, err: e.err })), shelfRemoved,
    paths: [...applied, ...conflicts].flatMap(pathsOf).map((rel) => toAbs(root, info, rel)), log,
  };
}

// The shelved file's text before and after (null for a side that has no such file), rebuilt from the patch: the
// file as it was in HEAD when shelved, with the shelved section applied to it in a private index.
async function shelfDiff(root, id, rel) {
  const info = await repoInfo(root);
  if (!info) return { ok: false, reason: 'notRepo', err: 'Not a Git repository' };
  let shelf;
  try { shelf = readShelf(root, id); } catch (err) { return { ok: false, err: err.message }; }
  const i = shelf.meta.files.findIndex((f) => f.rel === rel);
  if (i < 0) return { ok: false, err: `${rel} is not in this shelf` };
  const f = shelf.meta.files[i];
  if (f.binary) return { ok: true, binary: true, status: f.status };
  const sec = shelf.sections[i];
  const hunks = sec.indexOf('\n@@');
  const head = sec.subarray(0, hunks < 0 ? sec.length : hunks).toString('utf8');
  const pre = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d+))?$/m.exec(head);
  const mode = pre?.[3] || /^(?:old|deleted file) mode (\d+)$/m.exec(head)?.[1] || '100644';
  const idx = tempIndex();
  try {
    const g = (args, input) => git(root, atTop(info, args), input, idx.env);
    await g(['read-tree', '--empty']);
    let before = null;
    if (f.status !== 'added') {
      let oid = pre && !/^0+$/.test(pre[1]) ? pre[1] : null;
      // a pure rename has no index line: the file is as it was in the commit the shelf was made on
      if (!oid && shelf.meta.head) oid = (await g(['rev-parse', '-q', '--verify', `${shelf.meta.head}:${f.orig || f.rel}`])).out.trim() || null;
      const blob = oid && await g(['cat-file', 'blob', oid]);
      if (!blob || blob.code) return { ok: false, err: `The original version of ${f.orig || f.rel} is no longer in the repository.` };
      before = fileText(blob.buf);
      const add = await g(['update-index', '--add', '--cacheinfo', `${mode},${oid},${f.orig || f.rel}`]);
      if (add.code) return { ok: false, err: add.err };
    }
    let after = null;
    if (f.status !== 'deleted') {
      const r = await g([...APPLY, '--cached', idx.file('one.patch', sec)]);
      if (r.code) return { ok: false, err: r.err || r.out };
      const shown = await g(['show', `:${f.rel}`]);
      after = shown.code ? null : fileText(shown.buf);
    }
    return { ok: true, binary: false, status: f.status, before, after };
  } finally {
    idx.dispose();
  }
}

// ---------- background fetch ----------
// Auto-fetch (the renderer's timer, setting vcs.autoFetchMinutes) runs `git fetch --all --prune` quietly. It never
// starts while a git operation of the IDE runs for the project (or another program holds the index lock), and push
// and pull wait for one in flight, since two fetches writing FETCH_HEAD and remote refs at once fail on ref locks.
// It must never ask for anything: no terminal prompt, no askpass program (git's own GUI one, or one a parent shell
// set), credential helpers in non-interactive mode (Git Credential Manager only answers from its store), and ssh in
// batch mode unless the user configured an ssh command. A remote that needs credentials it does not have just fails.
const operations = new Map(); // project key -> IDE git operations (anything that is not a read) running
const fetches = new Map(); // project key -> the background fetch in flight (a promise)
const projectKey = (root) => path.resolve(String(root || '')).toLowerCase();
// Channels that only read: they neither hold off a background fetch nor wait for one.
const READS = new Set(['status', 'branches', 'show', 'fileAt', 'log', 'reflog', 'identity', 'commitDetails', 'blame', 'outgoing',
  'conflictSides', 'mergeVersions', 'stashList', 'stashFiles', 'shelves', 'shelfDiff', 'backgroundFetch', 'lastCommit', 'fileHistory']);
// Commands that write remote-tracking refs themselves.
const REMOTE_WRITERS = new Set(['push', 'pull']);
const FETCH_TIMEOUT = Number(process.env.PYIDE_GIT_FETCH_TIMEOUT_MS) || 120000;
const fetchLog = require('../diagnostics').logger('#git');
// The fetches' git processes, with the window that asked. git fetch runs helpers (git-remote-https, ssh) that a plain
// kill leaves running, so the whole tree is killed: at the time limit, when that window reloads or closes, and at quit
// (synchronously there, since Windows does not end a quitting program's children).
const fetchProcs = new Map(); // child process -> {owner, stopped, timedOut}
function killFetchTree(p, { sync = false } = {}) {
  if (!p?.pid || p.exitCode !== null || p.signalCode) return;
  if (process.platform !== 'win32') { try { p.kill(); } catch {} return; }
  const args = ['/pid', String(p.pid), '/T', '/F'];
  if (sync) require('child_process').spawnSync('taskkill', args, { windowsHide: true, timeout: 5000 });
  else spawn('taskkill', args, { windowsHide: true }).on('error', () => {});
}
function stopFetches({ owner = null, sync = false } = {}) {
  for (const [p, f] of fetchProcs) {
    if (owner && f.owner !== owner) continue;
    f.stopped = true;
    killFetchTree(p, { sync });
  }
}

async function asOperation(name, root, fn) {
  const k = projectKey(root);
  operations.set(k, (operations.get(k) || 0) + 1);
  try {
    if (REMOTE_WRITERS.has(name) && fetches.has(k)) await fetches.get(k);
    return await fn();
  } finally {
    const n = operations.get(k) - 1;
    if (n > 0) operations.set(k, n); else operations.delete(k);
  }
}

// -> {ok, skipped?: 'untrusted' | 'running' | 'busy' | 'notRepo' | 'noRemote', err?, timedOut?, stopped?, ms}
// owner: the webContents that asked (its reload or close stops the fetch).
async function backgroundFetch(root, { owner = null } = {}) {
  if (!trust.isTrusted(root)) return { ok: false, skipped: 'untrusted' };
  const k = projectKey(root);
  if (fetches.has(k)) return { ok: false, skipped: 'running' };
  if (operations.get(k)) return { ok: false, skipped: 'busy' };
  const run = (async () => {
    const info = await repoInfo(root);
    if (!info) return { ok: false, skipped: 'notRepo' };
    // another git (a terminal, another tool) is changing the repository
    if (fs.existsSync(path.join(info.gitDir, 'index.lock'))) return { ok: false, skipped: 'busy' };
    const remotes = (await git(root, ['remote'])).out.split(/\r?\n/).filter(Boolean);
    if (!remotes.length) return { ok: false, skipped: 'noRemote' };
    if (operations.get(k)) return { ok: false, skipped: 'busy' };
    // An empty GIT_ASKPASS / SSH_ASKPASS is "no askpass program" (also over core.askPass), so git goes on to the
    // disabled terminal prompt and fails.
    const env = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never' };
    const ssh = (await git(root, ['config', '--get', 'core.sshCommand'])).out.trim();
    if (!ssh && !process.env.GIT_SSH_COMMAND && !process.env.GIT_SSH) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
    const args = ['-c', 'credential.interactive=never', '-c', 'core.askPass=', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
      'fetch', '--all', '--prune', '--quiet', '--no-progress', '--no-recurse-submodules'];
    const started = Date.now();
    const track = { owner, stopped: false, timedOut: false };
    let child = null;
    const timer = setTimeout(() => { track.timedOut = true; killFetchTree(child); }, FETCH_TIMEOUT);
    let r;
    try {
      r = await git(root, args, '', env, { onSpawn: (p) => { child = p; fetchProcs.set(p, track); } });
    } finally {
      clearTimeout(timer);
      if (child) fetchProcs.delete(child);
    }
    const ms = Date.now() - started;
    if (track.stopped) return { ok: false, stopped: true, ms };
    if (r.code) {
      const err = (track.timedOut ?`git fetch did not finish in ${Math.round(FETCH_TIMEOUT / 1000)} s` : (r.err || r.out).trim()) || `git fetch exited with code ${r.code}`;
      fetchLog.warn(`Background fetch failed in ${root}: ${err.split(/\r?\n/).slice(-3).join(' | ')}`);
      return { ok: false, err, ms, ...(track.timedOut ? { timedOut: true } : {}) };
    }
    fetchLog.debug(`Background fetch of ${remotes.join(', ')} in ${root} took ${ms} ms`);
    return { ok: true, ms, remotes };
  })();
  fetches.set(k, run);
  try { return await run; } finally { fetches.delete(k); }
}
exports.backgroundFetch = backgroundFetch;
exports.stopFetches = stopFetches;
exports.fetchPids = () => [...fetchProcs.keys()].map((p) => p.pid).filter(Boolean);

exports.register = ({ ipcMain, app }) => {
  const h = (name, fn) => ipcMain.handle(`git:${name}`, (_e, ...args) => (READS.has(name) ? fn(...args) : asOperation(name, args[0], () => fn(...args))));
  shelfRoot = path.join(app.getPath('userData'), 'shelf');
  // Not through h(): the fetch belongs to the window that asked (a read, so no operation bookkeeping either).
  const watched = new WeakSet();
  ipcMain.handle('git:backgroundFetch', (e, root) => {
    const wc = e?.sender;
    if (wc?.on && !watched.has(wc)) {
      watched.add(wc);
      const gone = () => stopFetches({ owner: wc });
      wc.on('did-navigate', gone);
      wc.on('render-process-gone', gone);
      wc.once('destroyed', gone);
    }
    return backgroundFetch(root, { owner: wc || null });
  });
  app.on('will-quit', () => stopFetches({ sync: true }));

  h('status', status);

  h('init', async (root) => {
    const r = await git(root, ['init']);
    return { ok: !r.code, cmd: cmdLine(['init']), out: r.out, err: r.err, reason: r.reason };
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

  // Deletes a local branch, never the current one. Without force git refuses a branch that is not merged into its
  // upstream (or HEAD when it has none); the answer then lists the commits only that branch has, for the question
  // whether to delete it anyway. `hash` is the branch's last commit and `upstream` its branch.<name>.remote and .merge,
  // which git drops with the branch, so it can be restored as it was.
  h('deleteBranch', async (root, name, { force = false } = {}) => {
    const current = (await git(root, ['branch', '--show-current'])).out.trim();
    if (name === current) return { ok: false, reason: 'currentBranch', err: `Cannot delete the current branch ${name}.` };
    const hash = (await git(root, ['rev-parse', '-q', '--verify', `refs/heads/${name}`])).out.trim();
    const [remote, merge] = await Promise.all(['remote', 'merge'].map(async (k) => (await git(root, ['config', '--get', `branch.${name}.${k}`])).out.trim()));
    const args = ['branch', force ? '-D' : '-d', name];
    const r = await git(root, args);
    const res = { ok: !r.code, cmd: cmdLine(args), out: r.out, err: r.err, hash, ...(remote && merge ? { upstream: { remote, merge } } : {}) };
    if (!r.code || !/not fully merged/.test(r.err)) return res;
    const unmerged = (base) => git(root, ['log', '-n50', '--format=%h%x1f%s%x1f%an', `refs/heads/${name}`, '--not', base]);
    let target = current || 'HEAD';
    let log = await unmerged('HEAD');
    if (!log.out.trim()) {
      const up = (await git(root, ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${name}`])).out.trim();
      if (up) { target = up; log = await unmerged(up); }
    }
    const commits = log.out.split(/\r?\n/).filter(Boolean).map((l) => { const [short, subject, author] = l.split('\x1f'); return { short, subject, author }; });
    return { ...res, reason: 'notMerged', target, commits };
  });

  // upstream: {remote, merge} from deleteBranch.
  h('restoreBranch', async (root, name, hash, upstream) => {
    const steps = [['branch', name, hash], ...(upstream ? [['config', `branch.${name}.remote`, upstream.remote], ['config', `branch.${name}.merge`, upstream.merge]] : [])];
    const log = [];
    for (const args of steps) {
      const r = await git(root, args);
      log.push({ cmd: cmdLine(args), out: r.out, err: r.err });
      if (r.code) return { ok: false, log, err: r.err };
    }
    return { ok: true, log };
  });

  // A change of case only needs -M on Windows, where refs/heads/<to> is the file of the branch being renamed.
  h('renameBranch', async (root, from, to) => {
    const args = ['branch', from !== to && from.toLowerCase() === to.toLowerCase() ? '-M' : '-m', from, to];
    const r = await git(root, args);
    return { ok: !r.code, cmd: cmdLine(args), out: r.out, err: r.err };
  });

  // Content of a project file at `rev` (null when the file does not exist there).
  h('show', async (root, abs, rev = 'HEAD') => {
    const r = await git(root, ['show', `${rev}:./${relOf(root, abs)}`]);
    return r.code ? null : fileText(r.buf);
  });

  // Content of a repo-relative path at `rev`, for diffs of historical commits. opts.binary: a binary file (as the
  // editor judges one, main/text-codec.js) gives {binary: true} instead of its bytes decoded as text.
  h('fileAt', async (root, rev, repoRel, { binary = false } = {}) => {
    const info = await repoInfo(root);
    const r = await git(info?.top || root, ['show', `${rev}:${repoRel}`]);
    if (r.code) return null;
    if (binary && textCodec.looksBinary(r.buf) && !textCodec.detect(r.buf.subarray(0, 8000)).startsWith('utf-16')) return { binary: true };
    return fileText(r.buf);
  });

  // files: [path | {path, orig}]. A staged rename's original path is committed too (its deletion is already staged and
  // `git commit <paths>` implies --only), but is not passed to `git add`, which rejects a path gone from index and disk.
  // amend: replace the last commit; with no files only its message changes (--only keeps out what else is staged).
  h('commit', async (root, message, files, { amend = false } = {}) => {
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
    const commit = amend ? ['commit', '--amend'] : ['commit'];
    const args = whole ? [...commit, '-F', msgFile]
      : amend && !paths.length ? [...commit, '--only', '-F', msgFile]
        : [...commit, '-F', msgFile, '--pathspec-from-file=-', '--pathspec-file-nul'];
    const r = await git(root, args, [...paths, ...origs].map((p) => relOf(root, p)).join('\0'));
    try { fs.unlinkSync(msgFile); } catch {}
    const hash = r.code ? null : (await git(root, ['rev-parse', '--short', 'HEAD'])).out.trim();
    const shown = [...commit, '-m', message.split('\n')[0], ...(whole || !paths.length ? [] : ['--', ...paths.map((p) => relOf(root, p))])];
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

  // Commits that changed one file, newest first, followed through renames (git log --follow). `rel` is the file's
  // repo-relative path in that commit, `orig` its path before a rename there; a commit git lists without the file's
  // change (a merge) keeps the path the file had then.
  h('fileHistory', async (root, abs, max = 1000) => {
    const info = await repoInfo(root);
    if (!info) return [];
    const r = await git(root, ['log', '--follow', `-n${max}`, '-z', '--name-status',
      '--format=%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D%x1f%P', '--', relOf(root, abs)]);
    if (r.code) return [];
    let at = info.prefix + relOf(root, abs);
    return r.out.split('\x1e').filter(Boolean).map((rec) => {
      const end = rec.indexOf('\0');
      const [hash, short, author, email, time, subject, refs, parents] = (end < 0 ? rec : rec.slice(0, end)).split('\x1f');
      const [change] = end < 0 ? [] : parseNameStatus(rec.slice(end + 1).replace(/^\n/, ''));
      const entry = { hash, short, author, email, time: Number(time), subject, refs: refs ? refs.split(', ') : [], parents: parents ? parents.split(' ') : [],
        rel: change?.rel || at, ...(change?.orig ? { orig: change.orig } : {}), status: CHANGE_STATUS[change?.code] || 'modified' };
      at = entry.orig || entry.rel;
      return entry;
    });
  });

  // The last commit, for Amend: its message, and the upstream that already has it (amending it rewrites history
  // others may have pulled).
  h('lastCommit', async (root) => {
    const head = (await git(root, ['rev-parse', '-q', '--verify', 'HEAD'])).out.trim();
    if (!head) return null;
    const [msg, up] = await Promise.all([
      git(root, ['log', '-1', '--format=%B', 'HEAD']),
      git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    ]);
    const upstream = up.code ? null : up.out.trim();
    const pushed = !!upstream && !(await git(root, ['merge-base', '--is-ancestor', 'HEAD', '@{u}'])).code;
    return { hash: head, message: msg.out.replace(/\s+$/, ''), pushedTo: pushed ? upstream : null };
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
    // The editor's text in the file's own encoding, so unchanged lines match their committed bytes.
    const r = await git(root, ['blame', '--porcelain', '--contents', '-', '--', relOf(root, abs)], textCodec.encode(content, diskEncoding(abs)));
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
    const stage = async (n) => { const r = await git(root, ['show', `:${n}:./${rel}`]); return r.code ? null : fileText(r.buf); };
    const [base, ours, theirs] = await Promise.all([stage(1), stage(2), stage(3)]);
    let working = null;
    try { working = fileText(fs.readFileSync(abs)); } catch {}
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
    // Written back in the file's encoding: a CP949 file saved as UTF-8 would turn its Korean text into garbage.
    try {
      textCodec.write(abs, content, diskEncoding(abs));
    } catch (err) {
      return { ok: false, cmd: '', out: '', err: err.message };
    }
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

  // ---------- shelf ----------
  h('shelve', shelve);
  h('unshelve', unshelve);
  h('shelfDiff', shelfDiff);
  // Shelves of the project, newest first; each file's path is absolute for the project as open now.
  h('shelves', async (root) => {
    const info = await repoInfo(root);
    return listShelves(root).map((s) => ({ ...s, files: s.files.map((f) => ({ ...f, path: info ? toAbs(root, info, f.rel) : path.join(root, f.rel) })) }));
  });
  h('shelfRename', (root, id, name) => {
    try {
      const file = path.join(shelfDir(root, id), SHELF_META);
      const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
      meta.name = String(name).trim() || meta.name;
      fs.writeFileSync(file, JSON.stringify(meta, null, 1));
      return { ok: true };
    } catch (err) { return { ok: false, err: err.message }; }
  });
  h('shelfDelete', (root, id) => {
    try { fs.rmSync(shelfDir(root, id), { recursive: true, force: true }); return { ok: true }; } catch (err) { return { ok: false, err: err.message }; }
  });
};
