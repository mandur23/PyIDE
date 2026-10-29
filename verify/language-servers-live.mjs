// The real language servers (opt-in, not in CI: it downloads them): each is installed from the Install Manager into a
// temporary install folder with its pinned version and checksum (or its package manager), then used in the app:
// clangd (completion, hover, an error) and clang-format (Reformat Code) for C, rust-analyzer for a Rust file,
// csharp-ls (with the .NET SDK) for a C# project, Intelephense (with npm) for PHP; LS_LIVE_KOTLIN=1 adds the Kotlin
// server (363 MB). A server whose package manager is missing is reported as skipped. LS_LIVE_ONLY=clangd,php limits
// the servers. Port 9885.
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { launch, openFile } from './lib.mjs';

const J = JSON.stringify;
const work = mkdtempSync(path.join(tmpdir(), 'pyide-language-servers-live-'));
const root = path.join(work, 'root');
const project = path.join(work, 'project');
const files = {
  'main.c': '#include <stdio.h>\n\nstatic int add_numbers(int a, int b) { return a + b; }\n\nint main(void){int x=add_numbers(1,2);\nreturn x;}\n',
  'bad.c': 'int main(void) {\n    int x = "text";\n    return x;\n}\n',
  'src/main.rs': 'fn add_numbers(a: i32, b: i32) -> i32 {\n    a + b\n}\n\nfn main() {\n    let x = add_numbers(1, 2);\n}\n',
  'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
  'cs/Demo.csproj': '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net10.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n',
  'cs/Program.cs': 'using System;\n\nclass Program {\n    static void Main() {\n        Console.WriteLine("hi");\n    }\n}\n',
  'index.php': '<?php\nfunction add_numbers($a, $b) { return $a + $b; }\n\n',
  'Main.kt': 'fun addNumbers(a: Int, b: Int) = a + b\n\nfun main() {\n}\n',
};
for (const [rel, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(project, rel)), { recursive: true }); writeFileSync(path.join(project, rel), text); }

const only = (process.env.LS_LIVE_ONLY || '').split(',').filter(Boolean);
const wanted = (id) => (!only.length || only.includes(id)) && (id !== 'kotlin' || process.env.LS_LIVE_KOTLIN === '1');
const t = await launch({ projectDir: project, name: 'language-servers-live', port: 9885, env: { PYIDE_INSTALL_ROOT: root } });
const { js, until, type, press, check, sleep } = t;
const skipped = [];

async function install(id, toolchain) {
  const st = await js(`ide.installables.find(i => i.id === 'toolchain:${toolchain}').status()`);
  if (st.available === false) { skipped.push(`${id}: ${st.reason}`); return false; }
  const started = Date.now();
  await js(`ide.installer.run('toolchain:${toolchain}')`);
  const after = await js(`({ st: ide.installer.state('toolchain:${toolchain}'), status: await ide.installables.find(i => i.id === 'toolchain:${toolchain}').status() })`);
  check(after.status.installed, `${toolchain} installed (${Math.round((Date.now() - started) / 1000)} s)${after.status.installed ? '' : ` ${J(after.st.error || after.st)}`}`);
  return after.status.installed;
}
async function ready(id, label, ms = 180000) {
  await until(`/: (ready|error)/.test(document.getElementById('lsp-${id}-status')?.textContent || '')`, `${id} ready`, ms);
  const s = await js(`document.getElementById('lsp-${id}-status').textContent`);
  check(s === `${label}: ready`, `${label} server ready (${J(s)})`);
  return s === `${label}: ready`;
}
// Labels listed after typing `prefix` on a new last line of the active editor (retried while the server indexes).
async function completions(prefix, want, ms = 90000) {
  const end = Date.now() + ms;
  let labels = [];
  await js(`(() => { const e = ide.editor; const m = e.getModel(); const l = m.getLineCount(); e.setPosition({ lineNumber: l, column: m.getLineMaxColumn(l) }); e.focus(); return true; })()`);
  await type(prefix);
  while (Date.now() < end) {
    await js(`(ide.editor.trigger('t', 'editor.action.triggerSuggest', {}), true)`);
    await sleep(2500);
    labels = await js(`[...document.querySelectorAll('.suggest-widget.visible .monaco-list-row .label-name')].map(n => n.textContent)`);
    await js(`(ide.editor.trigger('t', 'hideSuggestWidget', {}), true)`);
    if (labels.some((l) => l.startsWith(want))) break;
  }
  return labels;
}
const markers = () => js(`ide.monaco.editor.getModelMarkers({ resource: ide.editor.getModel().uri }).map(m => m.severity + ' ' + m.message)`);

try {
  await js(`(ide.settings.set('aiComplete.enabled', false), true)`);
  if (wanted('clangd') && await install('clangd', 'clangd')) {
    await openFile(t, 'main.c');
    if (await ready('clangd', 'C/C++')) {
      const labels = await completions('\nadd_n', 'add_numbers');
      check(labels.some((l) => l.startsWith('add_numbers')), `clangd completes add_numbers (${J(labels.slice(0, 5))})`);
      await js(`(ide.editor.trigger('t', 'undo', {}), ide.editor.getModel().setValue(${J(files['main.c'])}), true)`);
      await js(`(ide.editor.setPosition({ lineNumber: 5, column: 23 }), ide.editor.trigger('t', 'editor.action.showHover', {}), true)`);
      await until(`[...document.querySelectorAll('.monaco-hover')].some(h => /add_numbers/.test(h.textContent))`, 'clangd hover', 30000).catch(() => {});
      const hover = await js(`[...document.querySelectorAll('.monaco-hover')].map(h => h.textContent).join(' | ')`);
      check(/int add_numbers\(int a, int b\)/.test(hover.replace(/\s+/g, ' ')), `clangd hover shows the signature (${J(hover.slice(0, 160))})`);
      await press('Escape');
      await openFile(t, 'bad.c');
      await until(`ide.monaco.editor.getModelMarkers({ resource: ide.editor.getModel().uri }).some(m => m.severity === 8)`, 'clangd error', 60000).catch(() => {});
      const ms = await markers();
      check(ms.some((m) => /^8 .*(incompatible|char)/i.test(m)), `clangd reports the type error (${J(ms)})`);
    }
  }
  if (wanted('clangd') && await install('clang-format', 'clangformat')) {
    await openFile(t, 'main.c');
    await js(`(ide.editor.focus(), true)`);
    await press('Ctrl+Alt+L');
    await until(`ide.editor.getModel().getValue().includes('int main(void) {')`, 'clang-format', 20000).catch(() => {});
    const text = await js(`ide.editor.getModel().getValue().replace(/\\r\\n/g, '\\n')`);
    check(text.includes('int main(void) {\n    int x = add_numbers(1, 2);\n    return x;\n}'), `clang-format formats in LLVM style with 4 spaces (${J(text)})`);
  }
  if (wanted('rust') && await install('rust', 'rustanalyzer')) {
    await openFile(t, 'src/main.rs');
    if (await ready('rust', 'Rust')) {
      const labels = await completions('\nfn x() { add_n', 'add_numbers', 120000);
      check(labels.some((l) => l.startsWith('add_numbers')), `rust-analyzer completes add_numbers${labels.length ? '' : ' (no list: Cargo is not installed here, so rust-analyzer may not load the crate)'} (${J(labels.slice(0, 5))})`);
    }
  }
  if (wanted('csharp') && await install('csharp', 'csharpls')) {
    await openFile(t, 'cs/Program.cs');
    if (await ready('csharp', 'C#', 240000)) {
      await js(`(ide.editor.getModel().setValue(${J(files['cs/Program.cs'].replace('Console.WriteLine("hi");', 'Console.Wri'))}), ide.editor.setPosition({ lineNumber: 5, column: 20 }), true)`);
      const labels = await completions('', 'WriteLine', 180000);
      check(labels.some((l) => l.startsWith('WriteLine')), `csharp-ls completes Console.WriteLine (${J(labels.slice(0, 5))})`);
    }
  }
  if (wanted('php') && await install('php', 'intelephense')) {
    await openFile(t, 'index.php');
    if (await ready('php', 'PHP')) {
      let labels = await completions('add_n', 'add_numbers');
      check(labels.some((l) => l.startsWith('add_numbers')), `Intelephense completes add_numbers (${J(labels.slice(0, 5))})`);
      labels = await completions(';\nstr_repl', 'str_replace');
      check(labels.some((l) => l.startsWith('str_replace')), `Intelephense completes PHP's str_replace (${J(labels.slice(0, 5))})`);
    }
  }
  if (wanted('kotlin') && await install('kotlin', 'kotlin')) {
    await openFile(t, 'Main.kt');
    if (await ready('kotlin', 'Kotlin', 300000)) {
      const labels = await completions('\nfun y() = addN', 'addNumbers', 240000);
      check(labels.some((l) => l.startsWith('addNumbers')), `the Kotlin server completes addNumbers (${J(labels.slice(0, 5))})`);
    }
  }
} catch (err) {
  check(false, `unexpected error: ${err.message}`);
}
for (const s of skipped) console.log(`SKIP ${s}`);
t.finish();
