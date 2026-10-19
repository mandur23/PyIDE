# PyIDE feature modules

PyIDE is an Electron + Monaco Python IDE modeled on PyCharm. The core (`main.js`, `preload.js`, `renderer/core/`) owns the window, editor, tabs, project tree, and the registries below. Every IDE capability beyond that is a feature module that owns its own files.

## Layout of a feature named `foo`

- `main/features/foo.js` exports `register(ctx)`. It is loaded automatically at startup. Use `ctx.ipcMain.handle('foo:…', …)` with channels prefixed by the feature name.
- `renderer/features/foo/index.js` is loaded automatically after Monaco and the core are ready, before the project opens. Wrap it in an IIFE and use the global `ide`.
- `renderer/features/foo/style.css` is loaded automatically if present. Reuse the CSS variables in `renderer/core/styles.css` (`--gray1`..`--gray12`, `--blue6`, `--green6`, `--red`, `--yellow`, `--mono`).
- `verify/foo.mjs` plus `verify/fixtures/foo/` hold the end-to-end check (see Verification).

## Main-process context (`ctx`)

`ipcMain`, `app`, `send(channel, payload)` to the renderer, `startProcess(cmd, args, {cwd, env}) -> id` (output streams to the renderer as process events, see `ide.proc`), `killProcess(id)`, `procs` (id -> ChildProcess, for stdin), `getWindow()`, `appDir`, `vendorDir`.

Bundled tools: `node_modules/pyright` (`langserver.index.js`, run with `process.execPath` and env `ELECTRON_RUN_AS_NODE=1`), and `vendor/` (a pip `--target` dir with `debugpy` and `ruff`; run ruff via `vendor/bin/ruff.exe`, and debugpy with the selected interpreter and `PYTHONPATH=vendor`).

## Renderer API (`window.ide`)

- State: `ide.root`, `ide.monaco`, `ide.editor`, `ide.tabs`, `ide.activeTab()`, `ide.findTab(path)`, `ide.currentInterp()` -> `{cmd, args, executable, version, label}`, `ide.interps`, `ide.reloadInterpreters()`.
- IPC: `ide.api.invoke(channel, ...args)`, `ide.api.on(channel, fn)`, plus `ide.api.read/write/list/walk/exists/create/rename/trash/openFolder/openFileDialog`.
- Events (`ide.on(name, fn)` returns an unsubscribe): `ready`, `projectOpened(root)`, `fileOpened(tab)`, `activeTabChanged(tab|null)`, `beforeSave(tab)`, `fileSaved(tab)`, `fileClosed(path)`, `filesChanged({created?, deleted?, renamed?})`, `interpreterChanged(interp)`, `problemsChanged`, `settingsChanged(key, value)`, `toolWindowShown(id)`, `treeRefreshed`.
- Files and tabs: `ide.openFile(path, {line, col, focus})`, `ide.openCustomTab({id, title, icon, mount(host, tab), onClose})` for non-text editors such as a diff view, `ide.closeTab(path, force)`, `ide.saveAll()`, `ide.reloadFromDisk(paths?)` after a tool rewrote files, `ide.isDirty(tab)`, `ide.renderTabs()`. A file tab is `{kind: 'file', path, title, model, savedVersion}`.
- Actions and keymap: `ide.registerAction({id, title, keys, run, when})`. Keys look like `'Ctrl+Shift+F10'`, `'Alt+ArrowLeft'`, `'Shift Shift'`. The last registration wins on a clash, so use PyCharm's default keymap and do not take a key another feature owns (table below). `ide.runAction(id)`.
- Tool windows: `ide.registerToolWindow({id, title, icon, side: 'left'|'bottom', keys, order, mount(container, tw)})` returns `tw` with `show()`, `hide()`, `toggle()`, `isVisible()`, `setActions([{icon, title, run}])`, `setBadge(text)`.
- Toolbar and status bar: `ide.registerToolbarItem({side: 'left'|'right', order, el})`, `ide.registerStatusItem({order, el})`. Toolbar right orders: interpreter 50, run target 60, run 70, debug 80, stop 90, settings 200. Toolbar left: VCS branch 10. Bottom tool window orders: Run 10, Debug 15, Find 18, Find in Files 20, Python Console 25, Terminal 30, Problems 40, Git 45, TODO 50, Python Packages 60. Until a window is shown, an area's default window is the one with the lowest order.
- Project tree: `ide.registerTreeDecorator(entry => ({color, badge}))`, `ide.registerTreeAction({title, when(entry), run(entry)})`, `ide.refreshTree()`, `ide.revealInTree(path)`.
- Problems: `ide.problems.set(source, path, [{line, col, endLine, endCol, msg, severity: 'error'|'warning'|'info'}])`, `ide.problems.clear(source)`, `ide.problems.all()`. Markers on open models are handled for you.
- Processes: after a main handler returns an id from `ctx.startProcess`, call `ide.proc.attach(id, {data(text, stream), exit(code)})`. Output that arrived early is replayed. Also `ide.proc.input(id, text)`, `ide.proc.kill(id)`.
- UI: `ide.ui.console(host, {input, placeholder, onInput})` gives a console with clickable tracebacks. `ide.ui.pick({placeholder, items | async query => items})` with items `{label, detail, hint, icon, value}`. `ide.ui.prompt(label, initial)`. `ide.ui.contextMenu(x, y, items)`. `ide.ui.dialog({title, body, buttons, width})`.
- Settings: `ide.settings.get(key, fallback)`, `ide.settings.set(key, value)`, persisted and broadcast via `settingsChanged`.
- Helpers: `ide.util.el(tag, cls, text)`, `basename`, `dirname`, `joinPath`, `samePath`, `rel(path)`.

## Cross-feature APIs

- `ide.lsp` (lsp): `request(method, params)` -> result or null, `documentSymbols(path)` -> LSP DocumentSymbol[] with `kindName` and 1-based line/col, `ready()` -> Promise<bool>, `status()`, `restart()`. Pyright is the only syntax/type diagnostics source (`ide.problems` source `'pyright'`).
- `ide.run` (run): `registerType`, `registerGutterProvider`, `runConfig`, `runContext`, `addTemporary`, `editConfigurations`, `sessions`, `activeSession`, `resolvePython(cfg)`. `ide.tests` (tests) and `ide.pyconsole` (pyconsole: `execute`, `restart`, `isRunning`).
- Debugger: action ids `Debug` (Shift+F9) and `StopDebug` (Ctrl+F2 while a session is active, registered on `ready`), event `debugSessionChanged(active)`; the toolbar Stop button stops a debug session when no run is active.
- `ide.openSettings(pageId)` (settings) and `ide.tooling` (`reformat`, `optimizeImports`, `fixAll`, `lint`). Ruff lint results use problems source `'ruff'`.
- Key handoffs through `when`: Ctrl+F2 is run's Stop unless a debug session is active; Ctrl+Shift+F10 is run's context run unless the caret is in a test (tests).

## Keymap ownership (PyCharm default keymap)

| Owner | Keys |
| --- | --- |
| core | Ctrl+S, Ctrl+O, Ctrl+Shift+N, Shift Shift, Ctrl+Shift+A, Ctrl+F4, Alt+Left/Right, Alt+Insert, Shift+Esc, Esc, Ctrl+D, Ctrl+Y, Ctrl+/, Ctrl+G, Ctrl+F, Ctrl+R, Ctrl+W, Ctrl+Shift+W, Alt+Shift+Up/Down, Ctrl+-/=, Alt+1 |
| run (built in) | Shift+F10, Ctrl+Shift+F10, Ctrl+F2, Alt+4 |
| terminal (built in) | Alt+F12 |
| problems (built in) | Alt+6 |
| lsp | Ctrl+Space (Monaco), Ctrl+B, Ctrl+Click, Ctrl+Alt+B, Alt+F7, Shift+F6, Ctrl+Q, Ctrl+P, Alt+Enter, F2 / Shift+F2 |
| debugger | Shift+F9, F8, F7, Shift+F8, F9, Ctrl+F8, Ctrl+Shift+F8, Alt+F9, Alt+F8, Alt+5 |
| search-nav | Ctrl+Shift+F, Ctrl+Shift+R, Ctrl+E, Ctrl+Shift+E, Alt+7, Ctrl+F12, Ctrl+Alt+Shift+N, Ctrl+N, Ctrl+Alt+Left/Right, Ctrl+Shift+Backspace |
| vcs | Ctrl+K, Ctrl+Shift+K, Ctrl+T, Alt+0, Alt+9, Ctrl+Alt+Z, Ctrl+Alt+Shift+Down/Up |
| run-tools | Alt+Shift+F10, Alt+Shift+F9, Alt+8 (Python Console), Ctrl+Shift+F10 on a test (via `when`) |
| tooling | Ctrl+Alt+L, Ctrl+Alt+O, Ctrl+Alt+S, Ctrl+Shift+Alt+S |

## Verification

`verify/lib.mjs` launches an isolated instance: a temp copy of `verify/fixtures/<fixture>/` as the project, temp user data, and a CDP port. It returns `js(expr)`, `until(expr, label)`, `press('Ctrl+Shift+F')` (real key events), `type(text)`, `click(selector)`, `shot(file)`, `check(ok, label)`, `finish()`. A run fails on any failed check or uncaught renderer exception. See `verify/core.mjs`. Each feature uses its own port so instances can run side by side.
