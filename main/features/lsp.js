// The Pyright language server for Python (main/lsp-server.js runs it, under the lsp:* channels).
const fs = require('fs');
const os = require('os');
const path = require('path');
const remote = require('../remote');
const projectRoots = require('../project-roots');
const { serve } = require('../lsp-server');

// Pyright's search paths and exclusions from the project's roots (Mark Directory As): the source roots replace its own
// guess (autoSearchPaths adds src/), so the editor resolves imports as Run does, and excluded folders leave its file
// list. Its default exclusions apply only while `exclude` is unset, so they are repeated, and the virtualenvs it would
// skip by itself (venv/ with its pyvenv.cfg) are listed.
function rootSettings(root) {
  const excluded = projectRoots.excludedDirs(root);
  return {
    autoSearchPaths: false,
    extraPaths: projectRoots.pythonPaths(root),
    ...(excluded.length ? { exclude: ['**/node_modules', '**/__pycache__', '**/.*', ...excluded, ...projectRoots.venvDirs(root)] } : {}),
  };
}

// Requests about the whole project. Pyright lists the project's source files after it has started (the initialize
// answer comes first) and logs "Found N source files" when it has; asked before that, it answers from the open files
// only: Type Hierarchy right after opening a project showed no subtypes in closed files (seen on the CI runner, whose
// small screen made the suite press Ctrl+H a little sooner), and Find Usages or a rename would miss them too. These
// wait for the list, or for 20 s after the server started if the log never comes.
const PROJECT_WIDE = new Set(['textDocument/references', 'textDocument/rename', 'workspace/symbol', 'callHierarchy/incomingCalls']);
const FILES_LISTED = /^(Found \d+ source files?|No source files found)/;

// Pyright 1.1.406 fails a references request it is told to cancel ("this._token.cancel is not a function", seen on the
// CI runner), so that one is only dropped, never sent $/cancelRequest.
const NO_CANCEL = new Set(['textDocument/references']);

// Pyright checks an open file after each edit (a 20,000-line file: about 5 s). Without its background-analysis thread
// it checks on the thread that answers requests, and a completion asked meanwhile waited for the whole check. The
// thread runs when Pyright gets --cancellationReceive, but the bundled Pyright starts it from the bundle chunk that
// holds its code, which only defines modules, so the thread did nothing and no diagnostics came. BOOT runs Pyright with
// worker_threads.Worker started from the language server entry instead (argv[1]), where a worker runs the analysis.
const BOOT = "const wt=require('worker_threads');const entry=process.argv[1];if(wt.isMainThread){const W=wt.Worker;"
  + 'wt.Worker=class extends W{constructor(_file,options){super(entry,options)}}}require(entry)';
// Pyright reads cancellations, and its two threads exchange them, as files in this folder under the temp folder.
const cancellationDir = (name) => path.join(os.tmpdir(), 'python-languageserver-cancellation', name);

// Folders left by IDE processes that ended without stopping Pyright (killed, crashed): named pyide-<pid>-<gen>.
function removeStaleCancellationDirs() {
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
  fs.readdir(cancellationDir(''), (_err, names) => {
    for (const name of names || []) {
      const pid = Number(/^pyide-(\d+)-\d+$/.exec(name)?.[1]);
      if (pid && pid !== process.pid && !alive(pid)) fs.rm(cancellationDir(name), { recursive: true, force: true }, () => {});
    }
  });
}

// Pyright's standard mode reports its type checker's findings as errors, also where a library's types are wider than
// the values it returns: BeautifulSoup types a["href"] as str | AttributeValueList, so a["href"].strip() in a program
// that runs fine was a red "Cannot access attribute "strip" for class "AttributeValueList"". PyCharm shows type
// findings as warnings; so does PyIDE. Errors stay for what fails whatever the types are: a name that does not exist
// or is never bound, a module that is not installed, and syntax errors (which have no rule). A project's own
// pyrightconfig.json or [tool.pyright] still decides, as Pyright lets it override these settings.
const TYPE_RULES_AS_WARNINGS = Object.fromEntries([
  'reportAttributeAccessIssue', 'reportOptionalMemberAccess', 'reportOptionalSubscript', 'reportOptionalCall',
  'reportOptionalIterable', 'reportOptionalContextManager', 'reportOptionalOperand', 'reportArgumentType',
  'reportAssignmentType', 'reportCallIssue', 'reportIndexIssue', 'reportOperatorIssue', 'reportReturnType',
  'reportGeneralTypeIssues', 'reportTypedDictNotRequiredAccess', 'reportPrivateImportUsage', 'reportFunctionMemberAccess',
  'reportAbstractUsage', 'reportUnhashable', 'reportIncompatibleMethodOverride', 'reportIncompatibleVariableOverride',
  'reportOverlappingOverload', 'reportInconsistentOverload', 'reportNoOverloadImplementation', 'reportInvalidTypeArguments',
  'reportInvalidTypeForm', 'reportAssertTypeFailure', 'reportRedeclaration', 'reportUnusedCoroutine', 'reportUnusedExcept',
].map((rule) => [rule, 'warning']));

function pyrightSpec(unpackedDir, root, pythonPath, locale) {
  const analysis = () => ({
    useLibraryCodeForTypes: true, diagnosticMode: 'openFilesOnly', typeCheckingMode: 'standard',
    diagnosticSeverityOverrides: TYPE_RULES_AS_WARNINGS, ...rootSettings(root),
  });
  const settingsFor = (section) => {
    if (section === 'python') return { pythonPath, analysis: analysis() };
    if (section === 'python.analysis') return analysis();
    if (section === 'python.pythonPath') return pythonPath;
    if (section === 'pyright') return {};
    return null;
  };
  return {
    name: 'Pyright',
    processName: 'Pyright language server',
    spawn(server) {
      const cancellation = `pyide-${process.pid}-${server.gen}`;
      const dir = cancellationDir(cancellation);
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      const entry = path.join(unpackedDir, 'node_modules', 'pyright', 'langserver.index.js');
      return {
        cmd: process.execPath,
        args: ['-e', BOOT, entry, '--stdio', `--cancellationReceive=file:${cancellation}`],
        // Pyright writes its diagnostics and hovers in the locale VSCODE_NLS_CONFIG names (the IDE's language);
        // without it it falls back to LC_ALL/LANG, which Windows does not set.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_NLS_CONFIG: JSON.stringify({ locale }) },
        cleanup(immediate) {
          if (immediate) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } else fs.rm(dir, { recursive: true, force: true }, () => {});
        },
      };
    },
    settingsFor,
    settings: () => ({ python: settingsFor('python') }),
    watched: /\.(py|pyi)$|(^|[\\/])(pyrightconfig\.json|pyproject\.toml)$/i,
    projectWide: PROJECT_WIDE,
    filesListed: FILES_LISTED,
    bindAfterEdits: true,
    noCancel: NO_CANCEL,
  };
}

exports.register = (ctx) => {
  removeStaleCancellationDirs();
  const { current } = serve(ctx, 'lsp', (root, pythonPath, locale = 'en') => pyrightSpec(ctx.unpackedDir, root,
    // A remote interpreter's Pyright runs here against a synced copy of its libraries (main/remote/index.js).
    remote.isRemoteExecutable(pythonPath) ? remote.pyrightPython(pythonPath) : pythonPath,
    // The UI language ('en', 'ko'), for Pyright's messages.
    /^[a-z]{2}(-[a-z]{2,4})?$/i.test(locale) ? locale.toLowerCase() : 'en'));
  // New roots reach a running server as new settings, which Pyright reads back through workspace/configuration.
  projectRoots.onChange((root) => {
    const s = current();
    if (!s?.initialized || s.dead || path.resolve(root).toLowerCase() !== path.resolve(s.root).toLowerCase()) return;
    s.configurationChanged();
  });
};
