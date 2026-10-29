// Language servers from the Install Manager (renderer/features/language-servers, main/features/language-servers.js),
// offline: stand-in archives served locally (pinned size and sha256 checked as for the real ones), a stand-in `go` for
// gopls's `via` install, a stand-in language server (verify/fixtures/language-servers/tools/standin-lsp.cjs) run in
// place of every server, and a stand-in clang-format. The Language Servers category and its rows (a `via` row whose
// package manager is missing cannot be installed); opening a .c file offers clangd and installs nothing until asked;
// installing it starts the client: completion, hover, Go to Declaration, errors in the editor, Reformat Code through
// the server and then through clang-format with the editor's indentation; rust-analyzer and gopls (installed with
// the pinned `go install` arguments); Safe Mode in an untrusted project; the Korean strings. Ports 9880, 9882-9883.
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import http from 'http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, openFile } from './lib.mjs';
import { missingTranslations } from './i18n-lib.mjs';

const J = JSON.stringify;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = path.join(HERE, 'fixtures', 'language-servers', 'tools');
const work = mkdtempSync(path.join(tmpdir(), 'pyide-language-servers-'));
const root = path.join(work, 'root');
const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
function archive(name, files) {
  const src = path.join(work, `src-${name}`);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    writeFileSync(path.join(src, rel), text);
  }
  const zip = path.join(work, `${name}.zip`);
  execFileSync(tar, ['-a', '-cf', zip, '-C', src, '.']);
  return readFileSync(zip);
}
const served = {
  '/clangd.zip': archive('clangd', { 'clangd_test/bin/clangd.exe': 'stand-in' }),
  '/clang-format.zip': archive('clang-format', { 'clang_format/data/bin/clang-format.exe': 'stand-in' }),
  '/ra.zip': archive('ra', { 'rust-analyzer.exe': 'stand-in' }),
};
const requests = [];
const server = http.createServer((req, res) => {
  requests.push(req.url);
  const body = served[req.url];
  if (!body) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-length': body.length });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const pin = (file, extra) => ({ url: `${base}${file}`, size: served[file].length, sha256: sha(served[file]), ...extra });
const feedFile = path.join(work, 'toolchains.json');
writeFileSync(feedFile, J({
  system: false,
  clangd: pin('/clangd.zip', { top: 'clangd_test' }),
  clangformat: pin('/clang-format.zip'),
  rustanalyzer: pin('/ra.zip'),
  // gopls through a stand-in go; Ruby and the .NET SDK missing; npm a stand-in that is never run.
  tools: { go: path.join(TOOLS, 'fake-go.cjs'), gem: path.join(work, 'no-ruby.cjs'), dotnet: path.join(work, 'no-dotnet.cjs'), npm: path.join(TOOLS, 'fake-go.cjs') },
}));
const env = { PYIDE_INSTALL_ROOT: root, PYIDE_TOOLCHAINS: feedFile, PYIDE_LSP_STANDIN: path.join(TOOLS, 'standin-lsp.cjs'),
  PYIDE_CLANG_FORMAT_STANDIN: path.join(TOOLS, 'fake-clang-format.cjs') };

const t = await launch({ fixture: 'language-servers/project', name: 'language-servers', port: 9880, env });
const { js, until, press, type, check, sleep } = t;
const statusText = (id) => js(`document.getElementById('lsp-${id}-status')?.textContent || ''`);
const text = () => js(`ide.editor.getModel().getValue().replace(/\\r\\n/g, '\\n')`);
const hint = () => js(`document.getElementById('toolingHint')?.textContent || ''`);
async function completions(prefix) {
  await js(`(() => { const e = ide.editor; e.trigger('t', 'hideSuggestWidget', {}); const m = e.getModel(); const l = m.getLineCount(); e.setPosition({ lineNumber: l, column: m.getLineMaxColumn(l) }); e.focus(); return true; })()`);
  await type(prefix);
  await js(`(ide.editor.trigger('t', 'editor.action.triggerSuggest', {}), true)`);
  await until(`!!document.querySelector('.suggest-widget.visible .monaco-list-row')`, `completion list after ${prefix}`, 10000).catch(() => {});
  await sleep(300);
  const labels = await js(`[...document.querySelectorAll('.suggest-widget.visible .monaco-list-row .label-name')].map(n => n.textContent)`);
  await js(`(ide.editor.trigger('t', 'hideSuggestWidget', {}), true)`);
  return labels;
}

try {
  await js(`(ide.settings.set('aiComplete.enabled', false), true)`);
  check(await js(`!!ide.languageServers`), 'language-servers plugin loaded');

  // ---------- Install Manager rows ----------
  const rows = await js(`Promise.all(ide.installables.filter(i => i.category === 'languages').map(async i => ({ id: i.id, name: i.name, st: await i.status() })))`);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  check(J(rows.map((r) => r.name)) === J(['clangd', 'rust-analyzer', 'gopls', 'Kotlin Language Server', 'csharp-ls', 'Ruby LSP', 'Intelephense', 'clang-format']),
    `the Language Servers category lists the servers and clang-format (${J(rows.map((r) => r.name))})`);
  check(rows.every((r) => !r.st.installed), 'nothing is installed at first');
  check(byId['toolchain:rubylsp'].st.available === false && byId['toolchain:rubylsp'].st.reason === 'Needs Ruby on PATH.', `Ruby LSP cannot be installed without Ruby (${J(byId['toolchain:rubylsp'].st)})`);
  check(byId['toolchain:csharpls'].st.available === false && byId['toolchain:gopls'].st.available !== false, 'csharp-ls needs the .NET SDK; gopls can be installed with the go found');
  await js(`(ide.installer.open(), true)`);
  await until(`!!document.querySelector('.inst-nav[data-filter="cat:languages"]')`, 'Language Servers category in the Install Manager');
  check((await js(`document.querySelector('.inst-nav[data-filter="cat:languages"]').textContent`)).includes('Language Servers'), 'the Install Manager shows a Language Servers category');
  await press('Escape');

  // ---------- C: offered, installed, used ----------
  await openFile(t, 'main.c');
  await until(`[...document.querySelectorAll('.ide-balloon')].some(n => /clangd \\(about 30 MB\\)/.test(n.textContent))`, 'clangd offered', 15000);
  check(true, 'opening a .c file offers clangd (about 30 MB)');
  check(await statusText('clangd') === 'C/C++: not installed', `status item: not installed (${await statusText('clangd')})`);
  check(!requests.length && !existsSync(path.join(root, 'clangd')), 'nothing is downloaded before the user asks');
  await js(`ide.languageServers.install('clangd')`);
  await until(`document.getElementById('lsp-clangd-status')?.textContent === 'C/C++: ready'`, 'clangd ready', 30000);
  check(requests.includes('/clangd.zip') && existsSync(path.join(root, 'clangd', 'clangd-23.1.0', 'clangd_test', 'bin', 'clangd.exe')), 'Download installs the pinned clangd into the install folder');
  let labels = await completions('\ncla');
  check(labels.includes('clangd_item'), `C completion comes from clangd (${J(labels)})`);
  await until(`ide.monaco.editor.getModelMarkers({ resource: ide.editor.getModel().uri }).some(m => /BAD is not allowed/.test(m.message))`, 'clangd diagnostics', 10000).catch(() => {});
  const marks = await js(`ide.monaco.editor.getModelMarkers({ resource: ide.editor.getModel().uri }).filter(m => /BAD/.test(m.message)).map(m => [m.startLineNumber, m.message])`);
  check(J(marks) === J([[3, 'clangd: BAD is not allowed']]), `the server's errors show in the editor (${J(marks)})`);
  await js(`(ide.editor.setPosition({ lineNumber: 2, column: 9 }), ide.editor.trigger('t', 'editor.action.showHover', {}), true)`);
  await until(`[...document.querySelectorAll('.monaco-hover')].some(h => h.textContent.includes('clangd hover'))`, 'hover', 8000).catch(() => {});
  check(await js(`[...document.querySelectorAll('.monaco-hover')].some(h => h.textContent.includes('clangd hover'))`), 'hover shows the server\'s text');
  await press('Escape');
  await js(`(ide.editor.setPosition({ lineNumber: 4, column: 12 }), ide.editor.focus(), true)`);
  await press('Ctrl+B');
  await until(`ide.editor.getPosition().lineNumber === 1`, 'went to the declaration', 8000).catch(() => {});
  check(await js(`ide.editor.getPosition().lineNumber`) === 1, 'Ctrl+B goes to the declaration the server gives');
  await press('Ctrl+Alt+L');
  await until(`ide.editor.getModel().getValue().startsWith('// formatted by clangd')`, 'formatted by clangd', 8000).catch(() => {});
  check((await text()).startsWith('// formatted by clangd\n'), `without clang-format, Reformat Code asks clangd (${J((await text()).slice(0, 40))})`);
  await js(`ide.installer.run('toolchain:clangformat')`);
  await until(`(async () => (await ide.installables.find(i => i.id === 'toolchain:clangformat').status()).installed)()`, 'clang-format installed', 20000);
  await js(`(ide.editor.focus(), true)`);
  await press('Ctrl+Alt+L');
  await until(`ide.editor.getModel().getValue().startsWith('// clang-format')`, 'formatted by clang-format', 8000).catch(() => {});
  const first = (await text()).split('\n')[0];
  check(first === '// clang-format {BasedOnStyle: LLVM, IndentWidth: 4, UseTab: Never, TabWidth: 4}', `with clang-format installed it formats, LLVM style with the file's indentation as fallback (${J(first)})`);
  check(/^Reformatted code: \d+ lines? changed$/.test(await hint()), `and says what changed (${J(await hint())})`);

  // ---------- Rust ----------
  await openFile(t, 'main.rs');
  await until(`document.getElementById('lsp-rust-status')?.textContent === 'Rust: not installed'`, 'rust offered');
  await js(`ide.languageServers.install('rust')`);
  await until(`document.getElementById('lsp-rust-status')?.textContent === 'Rust: ready'`, 'rust-analyzer ready', 30000);
  labels = await completions('\nrus');
  check(labels.includes('rust_item'), `Rust completion comes from rust-analyzer (${J(labels)})`);

  // ---------- Go through `go install` ----------
  await openFile(t, 'main.go');
  await until(`document.getElementById('lsp-go-status')?.textContent === 'Go: not installed'`, 'go offered');
  await js(`ide.languageServers.install('go')`);
  await until(`document.getElementById('lsp-go-status')?.textContent === 'Go: ready'`, 'gopls ready', 30000);
  const goArgs = JSON.parse(readFileSync(path.join(root, 'gopls', 'gopls-0.23.0', 'go-args.json'), 'utf8'));
  check(J(goArgs.args) === J(['install', 'golang.org/x/tools/gopls@v0.23.0']) && goArgs.env.GOTOOLCHAIN === 'local', `gopls is installed with go install at the pinned version (${J(goArgs)})`);
  labels = await completions('\ngo_');
  check(labels.includes('go_item'), `Go completion comes from gopls (${J(labels)})`);

  // ---------- Ruby: needs Ruby ----------
  await openFile(t, 'app.rb');
  await until(`document.getElementById('lsp-ruby-status')?.textContent === 'Ruby: not installed'`, 'ruby state');
  await until(`[...document.querySelectorAll('.ide-balloon')].some(n => /Install Ruby first/.test(n.textContent))`, 'ruby needs Ruby', 8000).catch(() => {});
  check(await js(`[...document.querySelectorAll('.ide-balloon')].some(n => /Ruby LSP, which is installed with Ruby\\. Install Ruby first\\./.test(n.textContent))`), 'Ruby: says Ruby must be installed first, with nothing to download');
} catch (err) {
  check(false, `unexpected error: ${err.message}`);
}
t.close();

// ---------------- untrusted project, Korean ----------------
// As verify/trust.mjs does: a home project opened before is trusted; the fixture, opened after, is previewed in Safe Mode.
const home = path.join(work, 'home');
const untrusted = path.join(work, 'untrusted');
mkdirSync(home);
cpSync(path.join(HERE, 'fixtures', 'language-servers', 'project'), untrusted, { recursive: true });
const uData = path.join(work, 'userdata-untrusted');
mkdirSync(uData);
writeFileSync(path.join(uData, 'settings.json'), J({ recentProjects: [{ path: home, opened: Date.now() }] }));
const u = await launch({ fixture: 'language-servers/project', name: 'language-servers-untrusted', port: 9882, projectDir: home, userData: uData, env: { ...env, PYIDE_TRUST_ALL: '' } });
try {
  u.js(`ide.openProject(${J(untrusted)})`);
  await u.until(`[...document.querySelectorAll('.dialog-title')].some(n => n.textContent.includes('Trust and Open Project?'))`, 'trust question');
  await u.js(`([...document.querySelectorAll('.dialog-buttons button')].find(b => b.textContent === 'Preview in Safe Mode').click(), true)`);
  await u.until(`ide.root && ide.util.samePath(ide.root, ${J(untrusted)}) && ide.trusted === false`, 'opened in Safe Mode');
  // The project finishes opening (tree, tabs of the project before closed) before a file is opened in it.
  await u.until(`!!document.querySelector('#tree .name') && !ide.tabs.some(t => t.path && !ide.util.isUnder(t.path, ide.root))`, 'Safe Mode project shown', 20000).catch(() => {});
  await u.sleep(1000);
  await openFile(u, 'main.c').catch(async () => { await u.sleep(1000); await openFile(u, 'main.c'); });
  await u.until(`document.getElementById('lsp-clangd-status')?.textContent === 'C/C++: Safe Mode'`, 'Safe Mode', 15000);
  u.check(true, 'an untrusted project does not start clangd (Safe Mode)');
} catch (err) {
  u.check(false, `unexpected error: ${err.message}`);
}
u.close();

const k = await launch({ fixture: 'language-servers/project', name: 'language-servers-ko', port: 9883, lang: 'ko-KR', env });
try {
  await k.js(`(ide.settings.set('aiComplete.enabled', false), true)`);
  await openFile(k, 'main.c');
  await k.until(`document.getElementById('lsp-clangd-status')?.textContent === 'C/C++: 준비됨'`, 'clangd ready (ko)', 30000);
  k.check(true, 'Korean status item: "C/C++: 준비됨"');
  await k.js(`(ide.installer.open(), true)`);
  await k.until(`!!document.querySelector('.inst-nav[data-filter="cat:languages"]')`, 'category (ko)');
  const cat = await k.js(`document.querySelector('.inst-nav[data-filter="cat:languages"]').textContent`);
  k.check(cat.includes('언어 서버'), `Korean category (${J(cat)})`);
  await k.js(`(document.querySelector('.inst-nav[data-filter="cat:languages"]').click(), true)`);
  await k.sleep(1500);
  const missing = await missingTranslations(k);
  k.check(missing.length === 0, `no untranslated strings (${J(missing)})`);
} catch (err) {
  k.check(false, `unexpected error: ${err.message}`);
}
k.close();
server.close();

const all = [...t.results, ...u.results, ...k.results];
const errors = [...t.consoleErrors, ...u.consoleErrors, ...k.consoleErrors];
if (errors.length) console.log(`renderer exceptions:\n  ${errors.join('\n  ')}`);
const failed = all.filter((r) => !r.ok).length;
console.log(`${all.length - failed}/${all.length} passed`);
process.exit(failed || errors.length ? 1 : 0);
