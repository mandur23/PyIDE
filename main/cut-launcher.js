// Nano Studio Cut is its own program: the Rust editor in cut-rs (nano-studio-cut.exe, `cargo build --release -p cut-app`).
// The JavaScript editor (renderer/features/cut, main/cut) stays in the repository as its specification and is not
// packaged. Every way of opening Cut ends here (main.js: the start chooser's Cut, --mode=cut, a .ncut file argument):
// the program starts on its own, detached, and this process quits once it has run for WATCH_MS. A start that fails, or
// a program that ends with an error code within that time, gets a message box. From then on the Cut program owns its
// lifetime: a later crash is its own to report (its session markers offer the autosave at the next start).
//
// What the program is told. The project to open is its first argument; the rest are environment variables:
const ENV = {
  // The Cut workspace (Projects, Autosave, Cache) the JavaScript Cut used: %USERPROFILE%\Nano Studio Cut.
  home: 'CUT_HOME',
  // The folder holding the Python servers whisper_server.py, voice_server.py and speaker_server.py.
  sidecars: 'CUT_SIDECAR_DIR',
  // The Claude Code CLI (claude.exe, or an npm install's claude.cmd) as main/ai/claude.js finds it; 'none' when a test
  // says there is none (PYIDE_CLAUDE_PATH=none); unset when it is not installed, so the program can look again later.
  claude: 'CUT_CLAUDE_PATH',
  // Nano Studio's settings file: the language and theme Code and Craft use, and the JavaScript Cut's cut.* settings.
  settings: 'CUT_STUDIO_SETTINGS',
  // The command that starts this app again, as a JSON array (its exe, the app folder in a source run, the test switch
  // when this run has it): Cut's Help › Check for Updates… runs it with --check-updates (main.js).
  app: 'CUT_STUDIO_APP',
  // This app's version, for Cut's About box.
  version: 'CUT_STUDIO_VERSION',
};
const EXE = 'nano-studio-cut.exe';
const SIDECARS = ['whisper_server.py', 'voice_server.py', 'speaker_server.py'];
// Long enough for a program that cannot make its window or GPU device to have ended.
const WATCH_MS = 5000;

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Where the program and the Python servers are: beside app.asar in an installed copy (package.json build.extraResources),
// cut-rs's release build and main/ai in a source run. PYIDE_CUT_EXE (a test hook, main/test-env.js) names another program.
function locate({ packaged, resourcesPath, appDir, env = process.env }) {
  if (packaged) return { exe: env.PYIDE_CUT_EXE || path.join(resourcesPath, 'cut', EXE), sidecars: path.join(resourcesPath, 'cut', 'sidecars') };
  return { exe: env.PYIDE_CUT_EXE || path.join(appDir, 'cut-rs', 'target', 'release', EXE), sidecars: path.join(appDir, 'main', 'ai') };
}

// The environment the program starts with: this process's, and ENV.
function cutEnv({ home, sidecars, claude, settingsFile, studioApp = [], version = '', env = process.env }) {
  const out = { ...env, [ENV.home]: home, [ENV.sidecars]: sidecars, [ENV.settings]: settingsFile, [ENV.app]: JSON.stringify(studioApp), [ENV.version]: version };
  delete out[ENV.claude];
  if (claude) out[ENV.claude] = claude;
  return out;
}

// Starts the program and watches it for watchMs.
// -> {state: 'running', pid} | {state: 'ended', code, pid} (it ended by itself in that time, code 0 included) |
//    {state: 'missing', exe} | {state: 'refused', exe, error} (Windows would not start it).
function start({ exe, project, env, cwd, watchMs = WATCH_MS }) {
  if (!fs.existsSync(exe)) return Promise.resolve({ state: 'missing', exe });
  return new Promise((resolve) => {
    let child;
    try {
      // stdio 'ignore': the program outlives this process, and a write to a pipe nobody reads would fail its prints.
      child = spawn(exe, project ? [project] : [], { cwd, env, detached: true, stdio: 'ignore', windowsHide: false });
    } catch (err) {
      return resolve({ state: 'refused', exe, error: err.code || err.message });
    }
    const timer = setTimeout(() => { child.removeAllListeners(); child.unref(); resolve({ state: 'running', pid: child.pid }); }, watchMs);
    child.once('error', (err) => { clearTimeout(timer); resolve({ state: 'refused', exe, error: err.code || err.message }); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ state: 'ended', code: code ?? signal, pid: child.pid }); });
  });
}

// NTSTATUS crash codes (0xC0000005, 0xC0000409) read better in hex.
const codeText = (code) => (typeof code === 'number' && (code < 0 || code > 0xffff) ? `0x${(code >>> 0).toString(16).toUpperCase()}` : String(code));

// What the message box says for a start that did not work, or null for one that did. tr(text) translates.
function failure(result, { packaged, tr }) {
  const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  const message = tr('Nano Studio Cut could not start.');
  if (result.state === 'missing') {
    const fix = packaged ? tr('Reinstall Nano Studio to repair it.') : tr('Build it in cut-rs with: cargo build --release -p cut-app');
    return { message, detail: `${fill(tr('The program is missing: {path}'), { path: result.exe })}\n\n${fix}` };
  }
  if (result.state === 'refused') return { message, detail: fill(tr('Windows did not start {path}: {error}'), { path: result.exe, error: result.error }) };
  if (result.state === 'ended' && result.code !== 0) return { message, detail: fill(tr('It ended right after starting, with exit code {code}.'), { code: codeText(result.code) }) };
  return null;
}

// tr for the main process: renderer/locales/<lang>.json, where the messages above are translated.
function translator(appDir, lang) {
  let dict = {};
  if (lang !== 'en') {
    try { dict = JSON.parse(fs.readFileSync(path.join(appDir, 'renderer', 'locales', `${lang}.json`), 'utf8')); } catch {}
  }
  return (text) => (typeof dict[text] === 'string' ? dict[text] : text);
}

module.exports = { ENV, EXE, SIDECARS, WATCH_MS, locate, cutEnv, start, failure, translator };
