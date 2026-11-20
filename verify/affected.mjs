// The checks a change needs, from the files it touched: the suites of verify/ci-suites.json and the Rust tests that
// cover those files, instead of all 195 suites and the whole Rust workspace (CI runs everything on the pushed commit;
// this is what is worth running before that, in minutes).
//   node verify/affected.mjs                 what the uncommitted changes need (the plan, nothing is run)
//   node verify/affected.mjs --since <ref>   what the changes since a commit need; `last-release` is the last
//                                            "Release x.y.z" commit
//   node verify/affected.mjs --run           run the plan, one suite after another (the shared desktop), then the
//                                            Rust checks; a failing suite's output is kept in verify/out/affected/
//   node verify/affected.mjs --files a b ... the plan for these paths (a check of this script)
// How a file finds its checks, in this order:
//   1. a suite that changed runs itself
//   2. AREAS: a part of the app (a path) and the suites that belong to it (by name)
//   3. LEARNED: couplings no rule would guess, each added after a failure that only CI or the full run caught
//   4. for a file of no area: a suite whose name or source names it (its plugin folder or its file name); for a
//      Rust module of cut-app: the tests that name cut_app::<module>
// A change marked wide (the core, the harness, a crate everything builds on) says so: its plan is a sample, and the
// full run is CI's. When CI fails on something the plan left out, add a line to LEARNED with the date and why:
// that is how the next change of the same file is checked in time.
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUST = 'cut-rs';
const CRAFT = /^(minecraft|craft-|private-share$|popout-craft$|stress-minecraft)/;

// path -> suites by name. `rust`: the Rust checks apply. `wide`: more depends on it than a plan can list.
const AREAS = [
  { area: 'documents', match: /(^|\/)(CHANGELOG|FEATURES|NEXT|README|CLAUDE)\.md$|^docs\//, none: true },
  { area: 'Cut (Rust)', match: /^cut-rs\//, rust: true, suites: /^cut-rust-launch$/ },
  { area: 'Cut (JavaScript, the frozen specification)', match: /^(renderer\/features\/cut\/|main\/cut\/)/, suites: /^cut-(?!rust)/ },
  { area: 'Craft', match: /^(renderer\/features\/minecraft\/|main\/minecraft\/|main\/features\/minecraft\.js$|tools\/nano-bridge\/)/, suites: CRAFT },
  { area: 'sharing', match: /^(main\/features\/port-sharing\.js$|renderer\/features\/port-sharing\/|main\/bore)/, suites: /^(port-sharing|bore-client$|private-share$|automation$)/ },
  { area: 'updates and the release', match: /^(scripts\/|main\/(updater|release-key)|renderer\/features\/updater\/|package(-lock)?\.json$|\.github\/)/, suites: /^(updater|release-harness|report-update|plugin-install-asar)$/ },
  // the list of suites and the tools around the tests: a suite added to the list is picked as a changed suite
  { area: 'test tools', match: /^verify\/(ci-suites\.json|affected\.mjs|clean\.mjs)$/, none: true },
  { area: 'the test harness', wide: true, match: /^verify\/(lib|ci-shard)\.mjs$/, suites: /^(test-env|process-tree|core|ui-icons)$/ },
  { area: 'the core of the window', wide: true, match: /^(renderer\/core\/|renderer\/index\.html$|main\/(main|preload|window|menu)[^/]*\.js$)/,
    suites: /^(core|core-lifecycle|ui-icons|ui-comfort|ui-feedback|ui-inspect-main|ui-inspect-dialogs|editors|popout|settings|keyboard|context-menu|main-menu-truth|multi-window)$/ },
];

// Found the hard way. [path, suites by name or Rust test files, when and why]
const LEARNED = [
  [/^cut-rs\/crates\/cut-app\/src\/prefs\//, { tests: ['speech', 'messages', 'pointer', 'text_prefs'] },
    '2026-11-20: the Settings window in a scroll area moved a row for a frame; speech.rs and messages.rs press its rows'],
  [/^cut-rs\/crates\/cut-app\/src\/panels\/dialogs\.rs$/, { tests: ['speech', 'messages', 'pointer', 'files', 'export'] },
    '2026-11-20: every dialog draws its buttons with dialogs::buttons'],
  [/^cut-rs\/crates\/cut-app\/src\/(theme\.rs|panels\/mod\.rs|windows\/view\.rs|workspaces\.rs)$/, { tests: ['pointer', 'view', 'windows', 'pictures', 'inventory'] },
    '2026-11-19: the panels\' frames and tabs are drawn here for every workspace'],
  [/^renderer\/features\/minecraft\/server-settings\.js$/, { suites: /^(minecraft|craft-health|craft-schedule|craft-mods|minecraft-antixray-ui)$/ },
    '2026-11-19: minecraft.mjs lists the settings tab\'s sections by id; a new section fails it'],
  [/^renderer\/core\/(ide\.js|styles\.css)$/, { suites: /^(terminal-split|workspace|database-sql-files|tests-tree-menu)$/ },
    '2026-11-19: ide.ui.dragResize is every splitter\'s drag; a cover over the handle took the double click of terminal-split'],
  [/^main\/installer\/toolchains\.js$/, { suites: /^(toolchains|java-check|language-support|language-servers)$/ },
    '2026-11-19: the Java the language server runs on is read from here'],
];

// Words too common to find a file's checks by.
const COMMON = new Set(['index', 'style', 'main', 'plugin', 'mod', 'lib', 'util', 'utils', 'view', 'page', 'state', 'core', 'ko', 'en', 'tests', 'test', 'types']);
// Rust crates everything else builds on: a change there is every crate's.
const BASE_CRATES = new Set(['cut-model', 'cut-time', 'cut-engine']);
// cut-app modules drawn or run by every screen.
const WIDE_MODULES = new Set(['shell', 'lib', 'state', 'main', 'actions', 'features']);

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
const lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

function changedFiles(argv) {
  const at = argv.indexOf('--files');
  if (at >= 0) return argv.slice(at + 1).filter((a) => !a.startsWith('--')).map((f) => f.replace(/\\/g, '/'));
  const since = argv.indexOf('--since');
  let ref = since >= 0 ? argv[since + 1] : null;
  if (ref === 'last-release') ref = lines(git('log', '--format=%H %s', '-200')).map((l) => l.split(' ')).find((p) => p[1] === 'Release' && /^\d+\.\d+\.\d+$/.test(p[2] || ''))?.[0];
  const out = new Set(lines(git('ls-files', '--others', '--exclude-standard')));
  for (const f of lines(git('diff', '--name-only', ref || 'HEAD'))) out.add(f);
  return [...out];
}

const suites = JSON.parse(readFileSync(path.join(ROOT, 'verify', 'ci-suites.json'), 'utf8'));
const sourceOf = (() => { const cache = new Map(); return (file) => { if (!cache.has(file)) cache.set(file, existsSync(path.join(ROOT, file)) ? readFileSync(path.join(ROOT, file), 'utf8') : ''); return cache.get(file); }; })();
const rustTests = existsSync(path.join(ROOT, RUST, 'crates', 'cut-app', 'tests'))
  ? readdirSync(path.join(ROOT, RUST, 'crates', 'cut-app', 'tests')).filter((f) => f.endsWith('.rs')).map((f) => f.slice(0, -3)) : [];

// What names a file in a test: its plugin folder or module, and its own name when that says something.
function wordsOf(file) {
  const parts = file.split('/');
  const base = parts.at(-1).replace(/\.[^.]+$/, '');
  const words = new Set();
  const plugin = /^renderer\/features\/([^/]+)\//.exec(file)?.[1] || /^main\/features\/([^/.]+)\.js$/.exec(file)?.[1];
  if (plugin) words.add(plugin);
  if (base.length >= 5 && !COMMON.has(base)) words.add(base);
  return [...words].filter((w) => !COMMON.has(w));
}

function plan(files) {
  const picked = new Map(); // suite name -> why
  const tests = new Map(); // cut-app test file -> why
  const crates = new Set();
  const areas = new Set();
  const notes = [];
  let rust = false;
  let wide = false;
  let rustAll = false;
  const pick = (re, why) => { for (const s of suites) if (re.test(s.name) && !picked.has(s.name)) picked.set(s.name, why); };
  for (const file of files) {
    const self = suites.find((s) => s.file === file);
    if (self) { picked.set(self.name, 'the suite itself changed'); continue; }
    if (/^cut-rs\/crates\/cut-app\/tests\/([^/]+)\.rs$/.test(file)) { tests.set(RegExp.$1, 'the test itself changed'); rust = true; areas.add('Cut (Rust)'); continue; }
    const area = AREAS.find((a) => a.match.test(file));
    if (area) {
      areas.add(area.area);
      if (area.none) continue;
      if (area.suites) pick(area.suites, area.area);
      if (area.wide) { wide = true; notes.push(`${file}: ${area.area}, which more depends on than this plan lists`); }
      if (area.rust) rust = true;
    }
    for (const [re, what, why] of LEARNED) {
      if (!re.test(file)) continue;
      if (what.suites) pick(what.suites, `learned: ${why}`);
      for (const t of what.tests || []) if (rustTests.includes(t) && !tests.has(t)) tests.set(t, `learned: ${why}`);
    }
    if (file.startsWith(`${RUST}/`)) {
      const crate = /^cut-rs\/crates\/([^/]+)\//.exec(file)?.[1];
      if (!crate) { rustAll = true; notes.push(`${file}: the workspace's own file`); continue; }
      crates.add(crate);
      if (BASE_CRATES.has(crate)) { rustAll = true; notes.push(`${file}: ${crate}, which every crate builds on`); continue; }
      if (crate !== 'cut-app') continue;
      const mod = /^cut-rs\/crates\/cut-app\/src\/([^/.]+)/.exec(file)?.[1];
      if (!mod) continue;
      if (WIDE_MODULES.has(mod)) { wide = true; notes.push(`${file}: every screen runs through it`); }
      for (const t of rustTests) if (!tests.has(t) && (t === mod || new RegExp(`cut_app::${mod}\\b`).test(sourceOf(`${RUST}/crates/cut-app/tests/${t}.rs`)))) tests.set(t, `names cut_app::${mod}`);
      continue;
    }
    // a file of no known area: a suite that names its plugin or the file
    if (area) continue;
    let named = false;
    for (const word of wordsOf(file)) {
      const inName = new RegExp(`(^|-)${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-|$)`, 'i');
      const inSource = new RegExp(`(features/|minecraft/|main/|['"\`/])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.js|/|['"\`])`);
      for (const s of suites) {
        if (!inName.test(s.name) && !inSource.test(sourceOf(s.file))) continue;
        named = true;
        if (!picked.has(s.name)) picked.set(s.name, `names ${word}`);
      }
    }
    if (!named && !file.startsWith('verify/')) notes.push(`${file}: no suite names it; check it by hand or add a line to AREAS or LEARNED`);
  }
  return { picked, tests, crates, areas, notes, rust, wide, rustAll };
}

function rustCommands(p) {
  if (!p.rust) return [];
  const out = [['cargo', ['fmt', '--all', '--', '--check']], ['cargo', ['clippy', '--workspace', '--all-targets', '--', '-D', 'warnings']]];
  if (p.rustAll) return [...out, ['cargo', ['test', '-j', '3', '--workspace', '--no-fail-fast']]];
  for (const c of p.crates) if (c !== 'cut-app') out.push(['cargo', ['test', '-j', '3', '-p', c]]);
  if (p.crates.has('cut-app') || p.tests.size) out.push(['cargo', ['test', '-j', '3', '-p', 'cut-app', '--lib', ...[...p.tests.keys()].sort().flatMap((t) => ['--test', t])]]);
  return out;
}

const argv = process.argv.slice(2);
const files = changedFiles(argv);
const p = plan(files);
const chosen = suites.filter((s) => p.picked.has(s.name));
const seconds = chosen.reduce((n, s) => n + (s.seconds || 60), 0);
const all = suites.reduce((n, s) => n + (s.seconds || 60), 0);
console.log(`${files.length} changed file(s); ${[...p.areas].join(', ') || 'no known area'}`);
if (!files.length) process.exit(0);
console.log(`\n${chosen.length} of ${suites.length} suites, about ${Math.ceil(seconds / 60)} min of ${Math.ceil(all / 60)}:`);
for (const s of chosen) console.log(`  node ${s.file}`.padEnd(52) + ` ${p.picked.get(s.name)}`);
const rust = rustCommands(p);
if (rust.length) {
  console.log(`\nRust, in ${RUST}/ (CARGO_INCREMENTAL=0):`);
  for (const [cmd, args] of rust) console.log(`  ${cmd} ${args.join(' ')}`);
  for (const [t, why] of p.tests) console.log(`    ${t}.rs: ${why}`);
}
if (p.notes.length) console.log(`\n${p.wide || p.rustAll ? 'Wide change' : 'Notes'}:\n${p.notes.map((n) => `  ${n}`).join('\n')}`);
console.log(`\nCI runs the rest on the pushed commit. A CI failure this plan left out goes into LEARNED (verify/affected.mjs).`);

if (argv.includes('--run')) {
  const logs = path.join(ROOT, 'verify', 'out', 'affected');
  mkdirSync(logs, { recursive: true });
  const failed = [];
  for (const s of chosen) {
    const started = Date.now();
    const r = spawnSync(process.execPath, [s.file], { cwd: ROOT, encoding: 'utf8', timeout: s.timeout * 60000, maxBuffer: 1 << 28, windowsHide: true });
    const text = `${r.stdout || ''}${r.stderr || ''}`;
    const fails = lines(text).filter((l) => l.startsWith('FAIL'));
    const ok = r.status === 0 && !fails.length;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${s.name} (${Math.round((Date.now() - started) / 1000)} s)${ok ? '' : `\n${fails.slice(0, 5).map((l) => `     ${l.slice(0, 300)}`).join('\n') || `     exit ${r.status ?? 'timeout'}`}`}`);
    if (!ok) { failed.push(s.name); writeFileSync(path.join(logs, `${s.name.replace(/[^\w.-]+/g, '_')}.log`), text); }
  }
  for (const [cmd, args] of rust) {
    const r = spawnSync(cmd, args, { cwd: path.join(ROOT, RUST), encoding: 'utf8', env: { ...process.env, CARGO_INCREMENTAL: '0' }, maxBuffer: 1 << 28, windowsHide: true });
    const text = `${r.stdout || ''}${r.stderr || ''}`;
    const bad = lines(text).filter((l) => /^(error|test .* FAILED|thread .* panicked)/.test(l));
    const ok = r.status === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${cmd} ${args.slice(0, 6).join(' ')}${ok ? '' : `\n${bad.slice(0, 8).map((l) => `     ${l.slice(0, 300)}`).join('\n')}`}`);
    if (!ok) { failed.push(`${cmd} ${args[0]}`); writeFileSync(path.join(logs, `cargo-${args[0]}.log`), text); }
  }
  console.log(failed.length ? `\n${failed.length} failed: ${failed.join(', ')} (output in verify/out/affected/)` : '\nall passed');
  process.exit(failed.length ? 1 : 0);
}
