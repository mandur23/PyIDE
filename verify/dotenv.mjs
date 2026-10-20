// .env files: the parser as a pure Node test, then Run, Debug, the test runner, the Python Console, explicit
// overrides, missing files, new terminals with the setting on and off, highlighting, and values kept out of the log.
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import path from 'path';
import { launch } from './lib.mjs';

const require = createRequire(import.meta.url);
const { parse, loadFiles } = require('../main/dotenv.js');
const { scrubText } = require('../main/diagnostics/redact.js');

const results = [];
const unit = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- parser (pure Node) ----------
{
  const base = { HOME_DIR: 'C:\\Users\\me', EMPTY: '' };
  const r = parse([
    '\uFEFF# a comment',
    'PLAIN=value',
    '  SPACED  =   padded value   ',
    'export EXPORTED=yes',
    'EMPTY_VALUE=',
    'INLINE=keep # comment',
    'HASH=a#b',
    'DQ="line1\\nline2\\t\\"q\\" \\\\ \\$NOT"',
    "SQ='raw \\n ${PLAIN}'",
    'REF=${PLAIN}-${HOME_DIR}',
    'DQREF="${PLAIN} and ${MISSING}"',
    'DEFAULTED=${MISSING:-fallback}',
    'EMPTYDEF=${EMPTY:-was empty}',
    'MULTI="first',
    'second"',
    'AFTER=ok # line numbers continue after a multi-line value',
    'not an entry',
    'BROKEN="never closed',
    'LAST=1',
    'PLAIN=overridden',
  ].join('\r\n'), (n) => base[n]);
  const e = r.env;
  unit(e.PLAIN === 'overridden' && e.SPACED === 'padded value' && e.EXPORTED === 'yes' && e.EMPTY_VALUE === '', 'KEY=value, surrounding spaces, export prefix, empty values; a later key wins');
  unit(e.INLINE === 'keep' && e.HASH === 'a#b', 'a # after whitespace starts a comment, a # inside a value does not');
  unit(e.DQ === 'line1\nline2\t"q" \\ $NOT', `double quotes process escapes (${JSON.stringify(e.DQ)})`);
  unit(e.SQ === 'raw \\n ${PLAIN}', 'single quotes are literal: no escapes, no expansion');
  unit(e.REF === 'value-C:\\Users\\me' && e.DQREF === 'value and ', `\${VAR} expands from earlier keys and the base environment; unknown names are empty (${e.REF} | ${e.DQREF})`);
  unit(e.DEFAULTED === 'fallback' && e.EMPTYDEF === 'was empty', '${VAR:-default} for unset and empty variables');
  unit(e.MULTI === 'first\nsecond' && e.AFTER === 'ok' && e.LAST === '1', 'quoted values may span lines');
  unit(!('BROKEN' in e) && same(r.errors, [17, 18]), `invalid lines are skipped and reported by line number only (${r.errors})`);
  unit(!('not' in e) && Object.keys(e).length === 15, `no stray keys (${Object.keys(e).join(',')})`);

  const later = parse('A=1\nB=${A}2\nA=3\nC=${A}');
  unit(later.env.B === '12' && later.env.C === '3', 'expansion uses the value a key has at that point');

  const fixture = path.resolve('verify', 'fixtures', 'dotenv');
  const both = loadFiles([path.join(fixture, '.env'), path.join(fixture, 'alt.env'), path.join(fixture, 'missing.env')], { PYIDE_DOTENV_PROC: 'proc' });
  unit(both.FOO === 'foo-from-dotenv-7f3a' && both.ALT === 'alt-value-91c2' && both.EXPANDED === 'base-x proc' && both.OVERRIDE === 'from-file',
    'loadFiles merges files in order, expands from the process environment and skips a missing file');
  if (process.platform === 'win32') {
    const tmp = path.join(mkdtempSync(path.join(tmpdir(), 'pyide-dotenv-')), 'case.env');
    writeFileSync(tmp, 'P=${path}\n');
    unit(loadFiles([tmp], { PATH: 'x' }).P === 'x', 'process variables resolve case-insensitively on Windows');
  }
  const scrubbed = scrubText(`spawned with FOO=foo-from-dotenv-7f3a and alt-value-91c2 (true)`);
  unit(!scrubbed.includes('foo-from-dotenv-7f3a') && !scrubbed.includes('alt-value-91c2') && scrubbed.includes('(true)'), `loaded values are masked in the log scrubber (${scrubbed})`);
}

// ---------- the IDE ----------
const PROC_VALUE = 'proc-var-5d1e';
const t = await launch({ fixture: 'dotenv', port: 9910, env: { PYIDE_DOTENV_PROC: PROC_VALUE } });
const { js, until, check, sleep } = t;
const q = JSON.stringify;
const runOut = () => js(`document.querySelector('.run-session:not(.hidden) .console')?.textContent || ''`);
const SCRIPT = `ide.util.joinPath(ide.root, 'show_env.py')`;
const config = (extra) => `({ ...ide.run.types.get('python').defaults(), id: 'cfg-' + Math.random().toString(36).slice(2), type: 'python', name: 'show_env', script: ${SCRIPT}, ...${q(extra)} })`;
async function runAndRead(extra, label) {
  await js(`ide.run.runConfig(${config(extra)}).then(() => true)`);
  await until(`(document.querySelector('.run-session:not(.hidden) .console')?.textContent || '').includes('Process finished with exit code')`, label, 30000);
  return runOut();
}

try {
  check(results.every(Boolean), `parser: ${results.filter(Boolean).length}/${results.length} pure Node checks (listed above)`);

  // ---------- Run ----------
  check((await js(`ide.run.types.get('python').fields.some(f => f.key === 'envFiles')`)) && (await js(`ide.run.types.get('python').defaults().envFiles`)) === '.env',
    'Python configurations have an Env files field that defaults to .env');
  let out = await runAndRead({}, 'default run');
  check(out.includes('FOO=[foo-from-dotenv-7f3a]'), 'Run: the script sees the .env value');
  check(out.includes(`EXPANDED=[base-x ${PROC_VALUE}]`), '${VAR} expands from earlier keys and the process environment');
  check(out.includes('LITERAL=[${BASE} stays]') && out.includes('OVERRIDE=[from-file]') && out.includes('ALT=[<unset>]'), 'single quotes stay literal, inline comments are dropped, other files are not loaded');

  out = await runAndRead({ env: 'OVERRIDE=explicit' }, 'run with an explicit variable');
  check(out.includes('OVERRIDE=[explicit]') && out.includes('FOO=[foo-from-dotenv-7f3a]'), 'an explicit run configuration variable overrides the env file');

  out = await runAndRead({ envFiles: '.env;alt.env' }, 'run with two env files');
  check(out.includes('ALT=[alt-value-91c2]') && out.includes('FOO=[foo-from-dotenv-7f3a]'), 'several env files load in order');

  out = await runAndRead({ envFiles: '' }, 'run without env files');
  check(out.includes('FOO=[<unset>]'), 'an empty Env files field loads nothing');

  out = await runAndRead({ envFiles: 'nope.env' }, 'run with a missing env file');
  check(out.includes('Env file not found:') && out.includes('nope.env') && out.includes('FOO=[<unset>]'), 'a missing env file is reported in the console');

  check(await js(`(() => { const c = ${config({})}; delete c.envFiles; return ide.run.envFiles(c).length === 1 && ide.run.envFiles(c)[0].toLowerCase() === ide.util.joinPath(ide.root, '.env').toLowerCase(); })()`),
    'configurations saved before the field existed use the project .env');

  // ---------- Edit Configurations shows the field ----------
  await js(`ide.run.editConfigurations()`);
  await until(`!!document.querySelector('.rc-dialog')`, 'configurations dialog');
  await js(`[...document.querySelectorAll('.rc-tool')].find(b => b.dataset.tool === 'add').click()`);
  await until(`[...document.querySelectorAll('.context-menu .menu-item')].some(n => n.textContent.includes('Python'))`, 'type menu');
  await js(`[...document.querySelectorAll('.context-menu .menu-item')].find(n => n.textContent.includes('Python')).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await js(`[...document.querySelectorAll('.context-menu .menu-item')].find(n => n.textContent.includes('Python'))?.click()`);
  await until(`!!document.querySelector('.rc-form [data-key="envFiles"]')`, 'Env files input', 5000);
  check((await js(`document.querySelector('.rc-form [data-key="envFiles"]').value`)) === '.env'
    && (await js(`document.querySelector('.rc-form [data-key="envFiles"]').closest('label').textContent`)).includes('Env files'), 'the run configuration form shows Env files with .env');
  await js(`[...document.querySelectorAll('.dialog button')].find(b => b.textContent === 'Cancel').click()`);

  // ---------- Debug ----------
  const debugOut = () => js(`document.querySelector('#dbgOut')?.textContent || ''`);
  const debugAndRead = async (cfg, label) => {
    await js(`ide.run.debugConfig(${cfg}).then(() => true)`);
    await until(`!ide.debugger.isActive() && (document.querySelector('#dbgOut')?.textContent || '').includes('OVERRIDE=')`, label, 40000);
    return debugOut();
  };
  out = await debugAndRead(config({ env: 'OVERRIDE=explicit' }), 'debug run');
  check(out.includes('FOO=[foo-from-dotenv-7f3a]') && out.includes('OVERRIDE=[explicit]'), 'Debug: the script sees the .env value, and explicit variables win');
  out = await debugAndRead(config({ envFiles: 'alt.env' }), 'debug with alt.env');
  check(out.includes('ALT=[alt-value-91c2]') && out.includes('FOO=[<unset>]'), "Debug uses the configuration's own env files");

  // ---------- test runner ----------
  await js(`ide.run.runConfig({ ...ide.run.types.get('pytest').defaults(), id: 'cfg-tests', name: 'env tests', type: 'pytest', target: 'test_env.py' }).then(() => true)`);
  await until(`(() => { const s = document.querySelector('.run-session:not(.hidden) .tr-status'); return s && s.dataset.state !== 'running'; })()`, 'tests finished', 60000);
  const status = await js(`document.querySelector('.run-session:not(.hidden) .tr-status').textContent`);
  check(status.includes('Tests passed: 1 of 1 test'), `a test sees the .env value (${status})`);
  check(await js(`ide.run.types.get('pytest').fields.some(f => f.key === 'envFiles')`), 'pytest configurations have the Env files field too');

  // ---------- Python Console ----------
  await js(`ide.toolWindows.get('PythonConsole').show()`);
  await until(`ide.pyconsole.isRunning()`, 'console started', 30000);
  await js(`ide.pyconsole.execute("import os; print('console:' + os.environ['FOO'])")`);
  await until(`document.querySelector('#pyconsoleOut').textContent.includes('console:foo-from-dotenv-7f3a')`, 'console output', 20000);
  check(true, 'the Python Console gets the project .env');

  // ---------- terminal ----------
  check((await js(`ide.settings.get('terminal.loadEnvFile', true)`)) === true, 'the terminal setting is on by default');
  await js(`ide.openSettings('terminal')`);
  await until(`!!document.querySelector('.settings [data-key="terminal.loadEnvFile"]')`, 'terminal settings page', 5000);
  check(await js(`document.querySelector('.settings [data-key="terminal.loadEnvFile"]').checked`), 'Settings › Terminal shows the setting checked');
  await js(`[...document.querySelectorAll('.dialog button')].find(b => b.textContent === 'Cancel')?.click()`);
  await js(`(ide.terminal.open(), true)`);
  await until(`ide.terminal.sessions().length >= 1`, 'terminal session');
  await until(`/PS .*project>/.test(ide.terminal.text())`, 'PowerShell prompt', 20000);
  await js(`ide.terminal.send('Write-Output "term:[$env:FOO]"\\r')`);
  await until(`ide.terminal.text().includes('term:[foo-from-dotenv-7f3a]')`, 'terminal sees FOO', 15000);
  check(true, 'a new terminal sees the .env value while the setting is on');
  await js(`(ide.settings.set('terminal.loadEnvFile', false), true)`);
  const before = await js(`ide.terminal.sessions().length`);
  await js(`(ide.terminal.open(), true)`);
  await until(`ide.terminal.sessions().length > ${before}`, 'second terminal session');
  await until(`/PS .*project>/.test(ide.terminal.text())`, 'second PowerShell prompt', 20000);
  await js(`ide.terminal.send('Write-Output "term2:[$env:FOO]"\\r')`);
  await until(`/term2:\\[\\]/.test(ide.terminal.text())`, 'second terminal output', 15000);
  check(true, 'with the setting off, a new terminal does not get it');

  // ---------- highlighting ----------
  await js(`ide.openFile(ide.util.joinPath(ide.root, '.env'))`);
  await until(`ide.activeTab()?.path.endsWith('.env') && ide.activeTab().model.getLanguageId() === 'dotenv'`, '.env opens as dotenv', 5000);
  const tokens = await js(`ide.monaco.editor.tokenize(ide.activeTab().model.getValue(), 'dotenv').map(line => line.map(t => t.type))`);
  const flat = tokens.map((l) => l.join(' '));
  check(flat[0].includes('comment') && flat[1].includes('builtin') && flat[1].includes('keyword') && flat[1].includes('string'), `.env lines are highlighted: comment, export, key, value (${flat.slice(0, 2).join(' / ')})`);
  check(flat[3].includes('variable') && flat[5].includes('comment') && !flat.some((l) => l.includes('invalid')), `\${VAR} references and inline comments are marked, nothing is invalid (${flat.join(' / ')})`);
  check(await js(`ide.monaco.editor.tokenize('A="x\\ny" # c\\nB=1', 'dotenv')[2].some(t => t.type.includes('keyword'))`), 'a multi-line quoted value ends and the next key is a key again');

  // ---------- values stay out of the log ----------
  await sleep(500);
  const logDir = path.join(t.userData, 'logs');
  const log = existsSync(logDir) ? readdirSync(logDir).map((f) => readFileSync(path.join(logDir, f), 'utf8')).join('\n') : '';
  check(log.length > 0 && !['foo-from-dotenv-7f3a', 'alt-value-91c2', `base-x ${PROC_VALUE}`].some((v) => log.includes(v)), 'no .env value appears in the IDE log');
} catch (err) {
  check(false, err.message);
}
t.finish();
