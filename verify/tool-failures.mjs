// What search, scanning and the tool integrations do when the files or the machine are not what they expect: Replace
// in Files on CRLF files and on files it cannot write, an unreadable folder in the project, Launchers in a project
// path holding cmd metacharacters, a ruff configuration ruff cannot read, Git missing or a damaged repository, and
// osv.dev out of reach.
import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import http from 'http';
import { createRequire } from 'module';
import path from 'path';
import { launch, openFile, tempDir } from './lib.mjs';

const iconv = createRequire(import.meta.url)('iconv-lite');
const J = JSON.stringify;
const freePort = () => new Promise((resolve) => {
  const s = http.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const refusedPort = await freePort();
const failing = http.createServer((_q, res) => { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('no'); });
await new Promise((r) => failing.listen(0, '127.0.0.1', r));

let firstResults = [];
const commitBox = (js) => js(`(ide.toolWindows.get('Commit').show(), new Promise(r => setTimeout(r, 50)).then(() => ({
  text: document.querySelector('.vcs-init')?.textContent || '', hidden: document.querySelector('.vcs-init')?.classList.contains('hidden'),
  create: !!document.querySelector('.vcs-init .vcs-init-btn'), error: document.querySelector('.vcs-init-error')?.textContent || '' })))`);

// ---------- one instance with Git and the usual PATH ----------
{
  const t = await launch({ fixture: 'tool-failures', port: 9278, env: { PYIDE_OSV_URL: `http://127.0.0.1:${refusedPort}` } });
  const { js, until, press, type, click, check, project } = t;
  // A section that throws counts as one failed check, and the next section still runs.
  const section = async (name, fn) => {
    try { await fn(); } catch (err) { console.log(err.stack || err); check(false, `${name} stopped: ${err.message.split('\n')[0]}`); }
  };
  const P = (...p) => path.join(project, ...p);
  const disk = (rel) => readFileSync(P(rel), 'utf8');
  const internal = (text) => js(`ide.api.invoke('diagnostics:errors').then(l => l.filter(e => (e.message + e.stack).includes(${J(text)})).length)`);
  const noAccess = P('noaccess');
  try {
    // a regex over CRLF files works on lines, as the editor's Ctrl+R does
    await section('A4', async () => {
      writeFileSync(P('crlf_find.py'), 'def f():  \r\n    pass\r\n\r\nx = 1   \r\n');
      const trailing = { query: '\\s+$', regex: true, caseSensitive: false, words: false, replacement: '' };
      const found = await js(`ide.api.invoke('search:find', ide.root, ${J(trailing)}, {})`);
      const crlfHits = found.files.find((f) => f.path.endsWith('crlf_find.py'))?.matches || [];
      check(crlfHits.length === 2 && crlfHits[0].line === 1 && crlfHits[0].col === 9 && crlfHits[1].line === 4,
        `the preview finds the trailing spaces of 2 lines, not a match on every CRLF line (${J(crlfHits.map((m) => [m.line, m.col, m.len]))})`);
      const replaced = await js(`ide.api.invoke('search:replace', ${J(trailing)}, [${J(P('crlf_find.py'))}])`);
      check(replaced.count === 2 && disk('crlf_find.py') === 'def f():\r\n    pass\r\n\r\nx = 1\r\n',
        `\\s+$ removes trailing spaces and keeps CRLF, the blank line and the final newline (${J(disk('crlf_find.py'))})`);
      const inBuffer = await js(`ide.api.invoke('search:replaceText', ${J(trailing)}, 'a  \\r\\n\\r\\nb \\r\\n')`);
      check(inBuffer.text === 'a\r\n\r\nb\r\n' && inBuffer.count === 2, `an unsaved CRLF buffer is replaced the same way (${J(inBuffer)})`);
      writeFileSync(P('crlf_join.py'), 'a = 1\r\nb = 2\r\n');
      const join = { query: 'a = 1\\nb', regex: true, caseSensitive: true, words: false, replacement: 'a = 1\\n\\nb' };
      await js(`ide.api.invoke('search:replace', ${J(join)}, [${J(P('crlf_join.py'))}])`);
      check(disk('crlf_join.py') === 'a = 1\r\n\r\nb = 2\r\n', `a multi-line regex matches \\n against CRLF and writes new line breaks as CRLF (${J(disk('crlf_join.py'))})`);
    });

    // Replace in Files names the files it could not change
    await section('A13', async () => {
      writeFileSync(P('kr949.py'), iconv.encode('# 대상 TOKEN\n', 'cp949'));
      writeFileSync(P('kr8.py'), '# 대상 TOKEN\n');
      writeFileSync(P('ro.py'), '# TOKEN\n');
      chmodSync(P('ro.py'), 0o444);
      const kr949Before = readFileSync(P('kr949.py'));
      const emoji = { query: 'TOKEN', regex: false, caseSensitive: true, words: false, replacement: '😀' };
      const r = await js(`ide.api.invoke('search:replace', ${J(emoji)}, ${J([P('kr949.py'), P('kr8.py'), P('ro.py')])})`);
      const why = Object.fromEntries((r.skipped || []).map((s) => [path.basename(s.path), s.reason + (s.code ? ` ${s.code}` : '')]));
      check(r.count === 1 && r.changed.length === 1 && r.changed[0].endsWith('kr8.py') && disk('kr8.py') === '# 대상 😀\n',
        `the UTF-8 file is replaced (${J({ count: r.count, changed: r.changed.map((p) => path.basename(p)) })})`);
      check(why['kr949.py'] === 'encoding' && /^error E(PERM|ACCES)$/.test(why['ro.py']), `the CP949 file and the read-only file are reported with why (${J(why)})`);
      check(readFileSync(P('kr949.py')).equals(kr949Before) && disk('ro.py') === '# TOKEN\n', 'and both are left as they were');

      writeFileSync(P('kr8.py'), '# 대상 TOKEN\n');
      await press('Ctrl+Shift+R');
      await until(`!!document.querySelector('#snReplace') && document.activeElement?.id === 'snQuery'`, 'Replace in Files dialog');
      await js(`document.querySelector('#snQuery').select()`);
      await type('TOKEN');
      await click('#snReplace');
      await type('😀');
      await until(`/3 matches in 3 files/.test(document.querySelector('#snStatus')?.textContent || '')`, 'preview of 3 files', 10000);
      await press('Enter');
      await until(`!!document.querySelector('#snReplaceAll')`, 'Replace All');
      await click('#snReplaceAll');
      await until(`document.querySelector('#snFindHead').textContent.includes('Replaced 1 occurrence in 1 file')`, 'replace summary', 15000);
      const summary = await js(`document.querySelector('#snFindHead .sn-note')?.textContent || ''`);
      check(summary.includes('Not replaced in 2 files:') && summary.includes('kr949.py (CP949 cannot store the new text)') && summary.includes('ro.py (Access is denied'),
        `the Find window's summary names the skipped files and why (${J(summary)})`);
      chmodSync(P('ro.py'), 0o644);
      check(await internal('kr949') === 0 && await internal('ro.py') === 0, 'skipping them records no internal error');
    });

    // an unreadable folder is left out of the project walk
    await section('A7', async () => {
      mkdirSync(noAccess);
      writeFileSync(path.join(noAccess, 'hidden.py'), '');
      execFileSync('icacls', [noAccess, '/deny', `${process.env.USERNAME}:(RX)`], { stdio: 'ignore' });
      const walked = await js(`ide.api.walk(ide.root).then(f => f.map(p => p.split('\\\\').pop()), e => 'ERR ' + e.message)`);
      check(Array.isArray(walked) && walked.includes('hello.py') && !walked.includes('hidden.py'), `Go to File's walk lists the readable files (${J(walked).slice(0, 160)})`);
      const listed = await js(`ide.api.invoke('fs:list', ${J(noAccess)}).then(() => 'listed', e => ide.util.errorText(e))`);
      check(listed === 'Access is denied (the file may be read-only)', `opening the folder in the tree says why (${J(listed)})`);
      await t.sleep(300);
      check(await internal('noaccess') === 0, 'neither records an internal error (the worker keeps the EPERM code)');
    });

    // Launchers in project paths holding & ^ % and spaces
    await section('A8', async () => {
      const base = tempDir('f3-launch');
      for (const dir of ['R&D^up%PATH%x', "R&D 100% ^up 'q' 한글"]) {
        const cwd = path.join(base, dir);
        mkdirSync(cwd);
        writeFileSync(path.join(cwd, 'run.bat'), '@echo off\r\necho hi %1\r\nnosuchcommand-f3\r\nexit /b 3\r\n');
        writeFileSync(path.join(cwd, 'tool.cmd'), '@echo off\r\necho tool "%~1"\r\nnosuchcommand-f3\r\nexit /b 0\r\n');
        writeFileSync(path.join(cwd, 'kr949.cmd'), iconv.encode('@echo off\r\necho 한글 출력\r\n', 'cp949'));
        const run = (entry, args) => js(`ide.api.invoke('workspace:start', ${J(cwd)}, ${J(entry)}, ${J(args)}, null).then(({ id, command }) => new Promise((resolve) => {
          let out = '';
          const timer = setTimeout(() => resolve({ out, code: 'timeout', command }), 20000);
          ide.proc.attach(id, { data: (s) => (out += s), exit: (code) => { clearTimeout(timer); resolve({ out, code, command }); } });
        }))`);
        const bat = await run({ kind: 'bat', file: path.join(cwd, 'run.bat'), cwd }, '--x');
        check(bat.out.includes('hi --x') && bat.out.includes('nosuchcommand-f3') && !/�/.test(bat.out) && bat.code === 3,
          `a .bat launcher runs in ${dir} with its exit code, cmd's own message readable (${J(bat)})`);
        const cmd = await run({ kind: 'launch', name: 'tool', exe: path.join(cwd, 'tool.cmd'), runtimeArgs: ['a & b'], cwd, env: {} }, '');
        check(cmd.out.includes('tool "a & b"') && cmd.code === 0, `a launch.json .cmd runs in ${dir} with its arguments intact (${J(cmd)})`);
        check(cmd.out.includes('nosuchcommand-f3') && !/�/.test(cmd.out), `and cmd's own message there is readable (${J(cmd.out)})`);
        const kr = await run({ kind: 'launch', name: 'kr', exe: path.join(cwd, 'kr949.cmd'), runtimeArgs: [], cwd, env: {} }, '');
        check(kr.out.includes('한글 출력') && kr.code === 0, `a launch.json .cmd written in CP949 shows its Korean output (${J(kr)})`);
      }
    });

    // a ruff configuration ruff cannot read is a problem, not a clean file
    await section('D4', async () => {
      writeFileSync(P('lintme.py'), 'import os\nimport sys\nx = undefined_name\n');
      writeFileSync(P('ruff.toml'), 'line-length = "very long"\n');
      const direct = await js(`ide.api.invoke('tooling:check', 'import os\\n', ${J(P('lintme.py'))}, { root: ide.root })`);
      check(!Array.isArray(direct) && direct.config?.endsWith('ruff.toml') && direct.line === 1 && direct.col === 15 && direct.error.includes('Failed to parse ruff.toml'),
        `tooling:check reports ruff's failure with the file and place (${J(direct)})`);
      await openFile(t, 'lintme.py');
      const ruffProblems = `ide.problems.all().filter(p => p.source === 'ruff').map(p => ({ file: p.path.split('\\\\').pop(), line: p.line, col: p.col, msg: p.msg, severity: p.severity }))`;
      await until(`${ruffProblems}.some(p => p.file === 'ruff.toml')`, 'ruff configuration problem', 15000);
      const bad = await js(ruffProblems);
      check(bad.length === 1 && bad[0].line === 1 && bad[0].col === 15 && bad[0].severity === 'error'
        && bad[0].msg.includes('Ruff cannot check Python files: Failed to parse ruff.toml') && bad[0].msg.includes('invalid type: string "very long", expected i64'),
      `Problems shows ruff.toml at line 1, column 15 with the cause (${J(bad)})`);
      check(await js(`document.querySelector('#toolingHint')?.textContent.includes('Failed to parse ruff.toml')`), 'and the editor hint says it once');
      writeFileSync(P('ruff.toml'), 'line-length = 100\n');
      await js(`ide.tooling.lint(ide.activeTab()).then(() => true)`);
      const good = await js(ruffProblems);
      check(!good.some((p) => p.file === 'ruff.toml') && good.some((p) => p.file === 'lintme.py' && p.msg.startsWith('F401')),
        `with the configuration fixed, the problem goes and the file's own findings show (${J(good.map((p) => p.msg))})`);
    });

    // a damaged repository is not offered Create Git Repository
    await section('D3', async () => {
      const none = await commitBox(js);
      check(none.text.includes('Version control is not configured') && none.create, 'outside a repository the Commit window offers Create Git Repository');
      execFileSync('git', ['init', '-q'], { cwd: project });
      writeFileSync(P('.git', 'HEAD'), Buffer.from('deadbeef00ff', 'hex'));
      await js(`ide.vcs.refresh().then(() => true)`);
      const damaged = await commitBox(js);
      check(!damaged.hidden && damaged.text.includes(`Git cannot use the repository in ${project}. It may be damaged:`) && !damaged.create && /not a git repository/i.test(damaged.error),
        `a damaged .git is named with git's message, without Create Git Repository (${J(damaged)})`);
      await js(`(ide.runAction('Git.Init'), true)`);
      await until(`ide.notifications.list().some(n => n.title === 'Git init failed')`, 'Git.Init refused');
      check(!readFileSync(P('.git', 'HEAD')).toString('latin1').startsWith('ref:'), 'Create Git Repository from the menu does not run git init over it');
      writeFileSync(P('.git', 'HEAD'), 'ref: refs/heads/master\n');
      await js(`document.querySelector('.vcs-init-retry').click()`);
      await until(`document.querySelector('.vcs-init').classList.contains('hidden')`, 'repository again after the fix', 10000);
      check(true, 'after HEAD is repaired, Refresh shows the repository');
    });

    // osv.dev out of reach reads as a sentence
    await section('D10', async () => {
      const osv = await js(`ide.api.invoke('vulnerabilities:check', { installed: [{ name: 'requests', version: '2.0.0' }], network: true, force: true })`);
      check(osv.errorKind === 'network' && /ECONNREFUSED/.test(osv.error), `a refused connection is a network error (${J({ kind: osv.errorKind, error: osv.error })})`);
      await js(`(ide.toolWindows.get('PythonPackages').show(), ide.packages.list = () => [{ name: 'requests', version: '2.0.0' }], true)`);
      await js(`ide.vulnerabilities.check({ manual: true }).then(() => true)`);
      const note = await js(`({ text: document.querySelector('#vulnStatus')?.textContent || '', title: document.querySelector('#vulnStatus')?.title || '' })`);
      check(note.text.includes('Could not check for vulnerabilities: Cannot reach the vulnerability database (osv.dev). Check your internet connection or proxy settings.')
        && !note.text.includes('ECONNREFUSED') && note.title.includes('ECONNREFUSED'), `the Packages note is translated text, Node's message in its tooltip (${J(note)})`);
    });
  } catch (err) {
    console.log(err.stack || err);
    check(false, `suite step failed: ${err.message.split('\n')[0]}`);
  } finally {
    try { execFileSync('icacls', [noAccess, '/remove:d', process.env.USERNAME], { stdio: 'ignore' }); } catch {}
    t.close();
    if (t.consoleErrors.length) check(false, `renderer exceptions:\n  ${t.consoleErrors.join('\n  ')}`);
    firstResults = t.results;
  }
}

// ---------- an instance whose PATH has no Git, and an OSV that answers 500 ----------
{
  const noGit = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
  const t = await launch({ fixture: 'tool-failures', name: 'tool-failures-nogit', port: 9279,
    env: { PATH: noGit, Path: noGit, PYIDE_OSV_URL: `http://127.0.0.1:${failing.address().port}` } });
  const { js, until, check, project } = t;
  try {
    execFileSync('git', ['init', '-q'], { cwd: project });
    await js(`ide.vcs.refresh().then(() => true)`);
    const box = await commitBox(js);
    check(!box.hidden && box.text.includes('Git is not installed or not on PATH. Install Git for Windows (git-scm.com) and restart Nano Studio.') && !box.create,
      `with Git missing the Commit window says so instead of "not configured" (${J(box)})`);
    await js(`(ide.runAction('Git.Init'), true)`);
    await until(`ide.notifications.list().some(n => n.title === 'Git init failed')`, 'Git init notification');
    const n = await js(`ide.notifications.list().find(n => n.title === 'Git init failed').text`);
    check(n.startsWith('Git is not installed or not on PATH') && !n.includes('ENOENT'), `Create Git Repository from the menu explains it (${J(n)})`);
    const osv = await js(`ide.api.invoke('vulnerabilities:check', { installed: [{ name: 'requests', version: '2.0.0' }], network: true, force: true })`);
    check(osv.errorKind === 'server', `an OSV error status is a server error (${J({ kind: osv.errorKind, error: osv.error })})`);
  } catch (err) {
    console.log(err.stack || err);
    check(false, `suite step failed: ${err.message.split('\n')[0]}`);
  } finally {
    failing.close();
    t.results.unshift(...firstResults);
    t.finish();
  }
}
