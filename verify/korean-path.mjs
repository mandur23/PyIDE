// A project whose path has Korean, spaces and parentheses (C:\...\한글 프로젝트 (테스트)\모듈\): run, debug to a
// breakpoint, pytest/unittest, Git status and log, Find in Files, Go to File, terminal, reformat, Pyright.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launch } from './lib.mjs';

const project = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-ko-')), '한글 프로젝트 (테스트)');
mkdirSync(path.join(project, '모듈'), { recursive: true });
writeFileSync(path.join(project, '모듈', '계산.py'), 'def 더하기(a, b):\n    return a + b\n');
writeFileSync(path.join(project, '모듈', '__init__.py'), '');
writeFileSync(path.join(project, '실행.py'), 'from 모듈.계산 import 더하기\n\n결과 = 더하기(2, 3)\nprint("결과:", 결과)\n');
writeFileSync(path.join(project, 'test_계산.py'), 'import unittest\nfrom 모듈.계산 import 더하기\n\n\nclass 테스트(unittest.TestCase):\n    def test_더하기(self):\n        self.assertEqual(더하기(1, 2), 3)\n');
writeFileSync(path.join(project, '지저분.py'), 'x=1;y = [1,2 ,3]\n');
const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.quotepath=off', ...a], { cwd: project, stdio: 'ignore' });
git('init', '-q'); git('add', '.'); git('commit', '-qm', '첫 커밋');

const t = await launch({ fixture: 'core', port: 9884, name: 'korean-path', projectDir: project });
const { js, until, press, type, sleep } = t;
const step = async (name, fn) => { try { const note = await fn(); t.check(true, note ? `${name} (${note})` : name); } catch (e) { t.check(false, `${name}: ${e.message.split('\n')[0].slice(0, 300)}`); } };
const open = async (rel) => { const p = path.join(project, rel); await js(`ide.openFile(${JSON.stringify(p)})`); await until(`ide.activeTab()?.path && ide.util.samePath(ide.activeTab().path, ${JSON.stringify(p)})`, `open ${rel}`, 15000); };
const runText = () => js(`document.querySelector('.run-session:not(.hidden) .console, #runOut')?.textContent || ''`);

await until(`document.querySelectorAll('#tree .node').length > 0`, 'tree', 30000);
await step('tree shows Korean names', () => until(`[...document.querySelectorAll('#tree .node .name')].some(n => n.textContent === '모듈')`, 'tree ko', 10000));
await step('Pyright resolves the Korean module (no import error)', async () => {
  await open('실행.py');
  await until(`/Pyright: ready/.test(document.querySelector('#lspStatus')?.textContent || '')`, 'pyright', 60000);
  await sleep(4000);
  const errs = await js(`ide.problems.all().filter(p => p.severity === 'error').map(p => p.msg)`);
  if (errs.length) throw new Error(JSON.stringify(errs));
});
await step('run the current file (Ctrl+Shift+F10)', async () => {
  await press('Ctrl+Shift+F10');
  await until(`(document.querySelector('.run-session:not(.hidden) .console, #runOut')?.textContent || '').includes('Process finished')`, 'finished', 30000);
  const out = await runText();
  if (!out.includes('결과: 5')) throw new Error(out.slice(-200));
});
await step('debug stops at a breakpoint in 계산.py', async () => {
  await open('모듈/계산.py');
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 2, column: 5 }), true)`);
  await press('Ctrl+F8');
  await open('실행.py');
  await press('Shift+F9');
  await until(`(() => { const s = window.__debugger.state(); const f = s?.state === 'suspended' && s.frames[s.frameIdx]; return f && f.path?.endsWith('계산.py') && f.line === 2; })()`, 'paused in 계산.py:2', 60000);
  await press('F9');
  await until(`(document.querySelector('#debugOut, .debug-console')?.textContent || document.body.innerText).includes('결과: 5')`, 'debug output', 30000).catch(() => {});
});
await step('unittest on test_계산.py', async () => {
  await open('test_계산.py');
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 1, column: 1 }), true)`);
  await press('Ctrl+Shift+F10');
  await until(`/Tests (passed|failed)/.test(document.querySelector('.run-session:not(.hidden) .tr-status')?.textContent || '')`, 'tests', 60000);
  const s = await js(`document.querySelector('.run-session:not(.hidden) .tr-status')?.textContent`);
  if (!/passed: 1|Tests passed/.test(s)) throw new Error(s);
  return s;
});
await step('Git: a modified Korean file is listed and the log shows the Korean commit', async () => {
  await open('지저분.py');
  await js(`(ide.editor.focus(), ide.editor.setPosition({ lineNumber: 1, column: 1 }), true)`);
  await type('# 수정\n'); await press('Ctrl+S');
  await js(`(ide.toolWindows.get('Commit')?.show(), true)`);
  await until(`document.body.innerText.includes('지저분.py')`, 'change listed', 20000);
  await js(`(ide.toolWindows.get('Git')?.show(), true)`);
  await until(`[...document.querySelectorAll('.vcs-log-rows .vcs-subject-text')].some(n => n.textContent === '첫 커밋')`, 'log', 20000);
});
await step('Reformat Code', async () => {
  await open('지저분.py');
  await press('Ctrl+Alt+L');
  await until(`ide.editor.getModel().getValue().includes('y = [1, 2, 3]')`, 'formatted', 20000);
});
await step('Find in Files finds Korean text', async () => {
  const r = await js(`ide.api.invoke('search:find', ide.root, { query: '더하기' })`);
  const n = (r.files || []).reduce((s, f) => s + f.matches.length, 0);
  if (n < 4) throw new Error(`only ${n} matches`);
  return `${n} matches in ${r.files.length} files`;
});
await step('Go to File finds 계산.py', async () => {
  await press('Ctrl+Shift+N'); await type('계산'); await sleep(1200);
  const items = await js(`[...document.querySelectorAll('#popupList .popup-item')].map(n => n.textContent).slice(0, 5)`);
  await press('Escape');
  if (!items.some((s) => s.includes('계산.py'))) throw new Error(JSON.stringify(items));
});
await step('terminal starts in the project folder', async () => {
  await press('Alt+F12');
  await until(`ide.terminal.sessions().length > 0`, 'term', 15000);
  await until(`ide.terminal.text().includes('한글 프로젝트 (테스트)>')`, 'prompt in folder', 30000);
});
await sleep(1500);
const internal = await js(`ide.api.invoke('diagnostics:errors')`).catch(() => []);
t.check(internal.length === 0 && t.consoleErrors.length === 0, `no internal errors or renderer exceptions (${internal.length}, ${t.consoleErrors.length})`);
await t.shot('korean-path.png');
t.finish();
