# PyIDE feature modules

PyIDE is an Electron + Monaco Python IDE modeled on PyCharm. The core (`main.js`, `preload.js`, `renderer/core/`) owns the window, editor, tabs, project tree, and the registries below. Every IDE capability beyond that is a feature module that owns its own files.

## Layout of a feature named `foo`

- `main/features/foo.js` exports `register(ctx)`. It is loaded automatically at startup. Use `ctx.ipcMain.handle('foo:…', …)` with channels prefixed by the feature name.
- `renderer/features/foo/index.js` is loaded automatically after Monaco and the core are ready, before the project opens. Wrap it in an IIFE and use the global `ide`.
- `renderer/features/foo/style.css` is loaded automatically if present. Reuse the CSS variables in `renderer/core/styles.css` (`--gray1`..`--gray12`, `--blue6`, `--green6`, `--red`, `--yellow`, `--mono`).
- `verify/foo.mjs` plus `verify/fixtures/foo/` hold the end-to-end check (see Verification).
- `renderer/features/foo/plugin.json` makes the feature a bundled plugin: `{id, name, version, vendor, description, main?: ['foo.js'], depends?: [ids], required?: true}`. `main` names its modules in `main/features/`. Disabled plugins load neither their renderer nor their main modules.
- `renderer/features/foo/locales/ko.json` holds its Korean strings (see Localization).

## Plugins

A plugin is a folder with `plugin.json`, plus optional `index.js`, `style.css`, `locales/<lang>.json`, and main-process modules listed in `main` (paths relative to the plugin folder). It uses exactly the same `ide` API as bundled features. Bundled plugins are the folders in `renderer/features/`. Installed plugins live in `<userData>/plugins/<id>/`. `plugins-catalog/` ships sample plugins that Settings › Plugins › Marketplace installs. `main/plugin-manager.js` owns discovery, enable/disable state (`<userData>/plugin-state.json`), install from a folder or `.zip`, and uninstall. Every change applies after a restart (`ide.restart()`), as in PyCharm. A plugin whose `depends` entry is disabled or missing does not load, so features must treat other plugins' APIs (`ide.lsp`, `ide.debugger`, `ide.run`…) as optional.

## Editor groups, split panes and windows

`renderer/core/editors.js` owns the editor area. A document (one per file: `{path, model, savedVersion, encoding}`) can be shown in several editor groups. A group is a split pane with its own tab bar and Monaco editor, and groups form a split tree (Split Right `Ctrl+\`, Split Down `Ctrl+Shift+\`, drag a tab onto a pane edge, Unsplit). Clones share the model, so edits appear in every pane. Model decorations (`model.deltaDecorations`) and markers show in every pane automatically.

- `ide.editor` is the active group's editor and changes when the user focuses another pane. Never cache it. Anything attached to an editor (`onMouseDown`, `onDidChangeCursorPosition`, `addAction`, `createDecorationsCollection`, content widgets, view zones) must go through `ide.onEditor(editor => …)`. It runs for every existing editor and for each pane created later, including editors that viewers embed. It returns an unsubscribe function. `ide.editors()` lists them, and `activeEditorChanged(editor)` and `editorCreated(editor)` are events.
- Editor options that apply everywhere (font, wrap, rulers, bracket colors) go through `ide.updateEditorOptions(opts)`, never `ide.editor.updateOptions`.
- `ide.tabs` lists one tab per open document plus custom tabs. `ide.findTab(path)` prefers the active group. A file tab has `{kind: 'file', path, title, model, doc, group, pinned, preview}`. `ide.openFile(path, {line, col, focus, group: 'right'|'down'|'window'|group, preview, asText})`. Also `ide.closeTab(path, force)`, `ide.closeAllTabs(force)`, `ide.getDocument(path)`, `ide.saveAll()`, `ide.reloadFromDisk(paths)`.
- Do not rely on DOM ids inside the editor area except `#editor` and `#customHost`, which always belong to the first group. Put overlays in `#editorArea`.
- File viewers: `ide.registerFileViewer({id, icon, match(path), binaryOnly?, text?, mount(host, {path, doc, tab}) -> {dispose?}})`. A matching viewer opens in a custom tab instead of a text editor. `text: true` viewers also get the file's document (use `ide.createEditor(host, {model: doc.model})` to embed an editor that plugins attach to). `binaryOnly` viewers take only files the text loader rejects. "Open as Text" bypasses viewers.
- Detached windows ("Open in New Window", `Shift+F4`) run the same renderer with `ide.detached === true` and load only plugins whose plugin.json has `"detached": true`. They show only editors. Unsaved text is synced between windows through the main process.
- Encoding: documents are read and written through `fs:readText` / `fs:writeText` (UTF-8, UTF-8 BOM, UTF-16, CP949), and the encoding is kept on save. Plugins that write files that may be open should still use `fs:write` and then `ide.reloadFromDisk`.

## Localization

UI text stays in English in the source and is translated by lookup, gettext style: the global `tr('Find in Files')`, or with placeholders `tr('Run {name}', { name })`. It is also available as `ide.t`. Each plugin's `locales/ko.json` maps the exact English string to Korean. `renderer/locales/ko.json` covers the core. The language (`appearance.language`: `system`, `en`, `ko`) is fixed for a session, so call `tr()` wherever text is produced. Calling it at module load is fine. Static markup uses `data-i18n`, `data-i18n-title` and `data-i18n-placeholder`. Never translate user data: code, file names, paths, process output, package names, git messages. Keep product names (Python, Git, Pyright, ruff, pytest, pip, venv) and key chords in English, as PyCharm's Korean language pack does. Use PyCharm's Korean terminology, for example 프로젝트, 실행, 디버그, 터미널, 문제, 커밋, 구조, 설정, 인터프리터, 중단점, 단계 건너뛰기 (Step Over), 단계 진입 (Step Into), 단계 나가기 (Step Out), 프로그램 재개, 파일에서 찾기, 사용 위치 찾기, 이름 변경, 코드 서식 다시 지정 (Reformat Code), import 최적화. `verify/i18n-lib.mjs` has `englishLeaks(ctx, selector)`, which lists visible English UI text, and `missingTranslations(ctx)`, which lists `tr()` strings without a Korean entry. Launch with `launch({..., lang: 'ko-KR'})` to test Korean. Tests default to English.

## Main-process context (`ctx`)

`ipcMain`, `app`, `send(channel, payload)` to the renderer, `startProcess(cmd, args, {cwd, env}) -> id` (output streams to the renderer as process events, see `ide.proc`), `killProcess(id)`, `procs` (id -> ChildProcess, for stdin), `getWindow()`, `appDir`, `vendorDir`.

Bundled tools: `node_modules/pyright` (`langserver.index.js`, run with `process.execPath` and env `ELECTRON_RUN_AS_NODE=1`), and `vendor/` (a pip `--target` dir with `debugpy` and `ruff`; run ruff via `vendor/bin/ruff.exe`, and debugpy with the selected interpreter and `PYTHONPATH=vendor`).

## Renderer API (`window.ide`)

- State: `ide.root`, `ide.monaco`, `ide.editor`, `ide.tabs`, `ide.activeTab()`, `ide.findTab(path)`, `ide.currentInterp()` -> `{cmd, args, executable, version, label}`, `ide.interps`, `ide.reloadInterpreters()`.
- IPC: `ide.api.invoke(channel, ...args)`, `ide.api.on(channel, fn)`, plus `ide.api.read/write/list/walk/exists/create/rename/trash/openFolder/openFileDialog`.
- Events (`ide.on(name, fn)` returns an unsubscribe): `ready`, `projectOpened(root)`, `fileOpened(tab)`, `activeTabChanged(tab|null)`, `beforeSave(tab)`, `fileSaved(tab)`, `fileClosed(path)`, `filesChanged({created?, deleted?, renamed?})`, `interpreterChanged(interp)`, `problemsChanged`, `settingsChanged(key, value)`, `toolWindowShown(id)`, `treeRefreshed`.
- Files and tabs: `ide.openFile(path, {line, col, focus})`, `ide.openCustomTab({id, title, icon, mount(host, tab), onClose})` for non-text editors such as a diff view, `ide.closeTab(path, force)`, `ide.saveAll()`, `ide.reloadFromDisk(paths?)` after a tool rewrote files, `ide.isDirty(tab)`, `ide.renderTabs()`. A file tab is `{kind: 'file', path, title, model, savedVersion}`.
- Actions and keymap: `ide.registerAction({id, title, keys, run, when, terminal})`. While a terminal has focus, only actions with `terminal: true` fire (tool-window toggles do automatically), so programs such as Claude Code keep Esc, Ctrl+K, Ctrl+T and the rest. Keys look like `'Ctrl+Shift+F10'`, `'Alt+ArrowLeft'`, `'Shift Shift'`. The last registration wins on a clash, so use PyCharm's default keymap and do not take a key another feature owns (table below). `ide.runAction(id)`.
- Tool windows: `ide.registerToolWindow({id, title, icon, side: 'left'|'bottom', keys, order, mount(container, tw)})` returns `tw` with `show()`, `hide()`, `toggle()`, `isVisible()`, `setActions([{icon, title, run}])`, `setBadge(text)`.
- Toolbar and status bar: `ide.registerToolbarItem({side: 'left'|'right', order, el})`, `ide.registerStatusItem({order, el})`. The main toolbar follows PyCharm's New UI. Left: main menu (`Alt+\`), project widget, branch widget (vcs order 10), workspace home (20). Right, by order: right-side items ordered 60-99 go inside the run widget pill (run target 60, run 70, debug 80, stop 90), then Claude Code 150, Search Everywhere 180, settings gear 200. The interpreter picker is the status-bar widget; `ide.setInterpreter(executable)` selects one. `ide.icon(name, fallbackGlyph)` returns a PyCharm New UI SVG icon from `renderer/core/icons.js` (generated by `tools/build-icons.mjs`).
- Projects: `ide.openProject(dir)`, `ide.closeProject()` (back to the welcome screen, emits `projectClosed`), `ide.newProject()` (the New Project wizard, `renderer/core/project-wizard.js` + `main/new-project.js`), recent projects in the `recentProjects` setting. The main menu (`renderer/core/mainmenu.js`) lists actions by id and hides those whose plugin is disabled. Toolbar left: VCS branch 10. Bottom tool window orders: Run 10, Debug 15, Find 18, Find in Files 20, Python Console 25, Terminal 30, Problems 40, Git 45, TODO 50, Python Packages 60. Until a window is shown, an area's default window is the one with the lowest order.
- Project tree: `ide.registerTreeDecorator(entry => ({color, badge}))`, `ide.registerTreeAction({title, when(entry), run(entry)})`, `ide.refreshTree()`, `ide.revealInTree(path)`.
- Problems: `ide.problems.set(source, path, [{line, col, endLine, endCol, msg, severity: 'error'|'warning'|'info'}])`, `ide.problems.clear(source)`, `ide.problems.all()`. Markers on open models are handled for you.
- Processes: after a main handler returns an id from `ctx.startProcess`, call `ide.proc.attach(id, {data(text, stream), exit(code)})`. Output that arrived early is replayed. Also `ide.proc.input(id, text)`, `ide.proc.kill(id)`.
- UI: `ide.ui.console(host, {input, placeholder, onInput})` gives a console with clickable tracebacks. `ide.ui.pick({placeholder, items | async query => items})` with items `{label, detail, hint, icon, value}`. `ide.ui.prompt(label, initial)`. `ide.ui.contextMenu(x, y, items)` with items `{label, hint, icon, checked, disabled, detail, run, submenu: items | () => items}` or `{separator: true}` / `{header}` (submenus open on hover or Right; Up/Down/Enter/Left/Esc work). `ide.ui.dialog({title, body, buttons, width})`.
- Settings: `ide.settings.get(key, fallback)`, `ide.settings.set(key, value)`, persisted and broadcast via `settingsChanged`.
- Helpers: `ide.util.el(tag, cls, text)`, `basename`, `dirname`, `joinPath`, `samePath`, `isUnder(path, dir)` (same path or inside it), `rel(path)`.

## Cross-feature APIs

- `ide.lsp` (lsp): `request(method, params)` -> result or null, `documentSymbols(path)` -> LSP DocumentSymbol[] with `kindName` and 1-based line/col, `ready()` -> Promise<bool>, `status()`, `restart()`. Pyright is the only syntax/type diagnostics source (`ide.problems` source `'pyright'`).
- `ide.run` (run): `registerType`, `registerGutterProvider`, `runConfig`, `runContext`, `addTemporary`, `editConfigurations`, `sessions`, `activeSession`, `resolvePython(cfg)`. `ide.tests` (tests) and `ide.pyconsole` (pyconsole: `execute`, `restart`, `isRunning`).
- Debugger: action ids `Debug` (Shift+F9) and `StopDebug` (Ctrl+F2 while a session is active, registered on `ready`), event `debugSessionChanged(active)`; the toolbar Stop button stops a debug session when no run is active.
- `ide.openSettings(pageId)` (settings) and `ide.tooling` (`reformat`, `optimizeImports`, `fixAll`, `lint`). Ruff lint results use problems source `'ruff'`.
- `ide.database` (database): `addDataSource(cfg)` -> id, `list()`, `query(id, sql, opts)`, `openConsole(id)`, `drivers()`, `activeConsole()`.
- `ide.installer` (installer): `open(category?)`, `refresh()`, `register(item)`, `pip({package, name, description, category})`. Any plugin lists installables by pushing to `ide.installables` and emitting `installablesChanged` (see Install Manager below), so load order does not matter.
- Settings pages: a plugin pushes `{id, title: () => string, keywords, group?: 'ai', mount(host, ctx)}` to `ide.settingsPages`; `ctx.ui` has `section`, `fieldRow`, `checkbox`, `numberInput(key, {min, max, fallback})` and `selectInput(key, options, fallback)`, whose values follow the dialog's OK/Apply/Cancel.
- `ide.aiComplete` (ai-complete): `status()`, `mode()`, `isVisible(editor)`. `ide.aiEdit` (ai-edit): `open`, `session`, `nes`, `nesEnabled`, `setNes`.
- Key handoffs through `when`: Ctrl+F2 is run's Stop unless a debug session is active; Ctrl+Shift+F10 is run's context run unless the caret is in a test (tests).

## Keymap ownership (PyCharm default keymap)

| Owner | Keys |
| --- | --- |
| core | Ctrl+S, Ctrl+O, Ctrl+Shift+N, Shift Shift, Ctrl+Shift+A, Ctrl+F4, Alt+Left/Right, Alt+Insert, Shift+Esc, Esc, Ctrl+D, Ctrl+Y, Ctrl+/, Ctrl+G, Ctrl+F, Ctrl+R, Ctrl+W, Ctrl+Shift+W, Alt+Shift+Up/Down, Ctrl+-/=, Alt+1 |
| run (built in) | Shift+F10, Ctrl+Shift+F10, Ctrl+F2, Alt+4 |
| terminal | Alt+F12, Ctrl+Esc (Claude Code), Ctrl+Alt+K (send file reference to Claude Code), Ctrl+Shift+T inside a terminal (new session) |
| problems (built in) | Alt+6 |
| lsp | Ctrl+Space (Monaco), Ctrl+B, Ctrl+Click, Ctrl+Alt+B, Alt+F7, Shift+F6, Ctrl+Q, Ctrl+P, Alt+Enter, F2 / Shift+F2 |
| debugger | Shift+F9, F8, F7, Shift+F8, F9, Ctrl+F8, Ctrl+Shift+F8, Alt+F9, Alt+F8, Alt+5 |
| search-nav | Ctrl+Shift+F, Ctrl+Shift+R, Ctrl+E, Ctrl+Shift+E, Alt+7, Ctrl+F12, Ctrl+Alt+Shift+N, Ctrl+N, Ctrl+Alt+Left/Right, Ctrl+Shift+Backspace |
| vcs | Ctrl+K, Ctrl+Shift+K, Ctrl+T, Alt+0, Alt+9, Ctrl+Alt+Z, Ctrl+Alt+Shift+Down/Up |
| run-tools | Alt+Shift+F10, Alt+Shift+F9, Alt+8 (Python Console), Ctrl+Shift+F10 on a test (via `when`) |
| tooling | Ctrl+Alt+L, Ctrl+Alt+O, Ctrl+Alt+S, Ctrl+Shift+Alt+S |
| semantic | Ctrl+Alt+F (Semantic Search popup) |
| database | Ctrl+Enter (Execute Statement, only while a query console has focus) |
| ai-complete | Tab / Ctrl+Right / Esc while ghost text is visible, Ctrl+Alt+\ (Trigger AI Completion) |
| ai-edit | Ctrl+I (Edit with Claude), Ctrl+Enter / Tab / Esc while reviewing, Tab / Esc for a visible next edit suggestion (never while ghost text, the suggest widget or a snippet is active) |

## Verification

`verify/lib.mjs` launches an isolated instance: a temp copy of `verify/fixtures/<fixture>/` as the project, temp user data, and a CDP port. It returns `js(expr)`, `until(expr, label)`, `press('Ctrl+Shift+F')` (real key events), `type(text)`, `click(selector)`, `shot(file)`, `check(ok, label)`, `finish()`. A run fails on any failed check or uncaught renderer exception. See `verify/core.mjs`. Each feature uses its own port so instances can run side by side.

## Semantic search (EmbeddingGemma 2)

`renderer/features/semantic` and `main/features/semantic.js` add meaning-based search with Google's EmbeddingGemma 2 (`google/embeddinggemma-2`, Apache 2.0) running locally. The model runs in a Python sidecar (`main/semantic/embed_server.py`) inside a private venv at `~\.pyide\semantic\venv` that reuses the system PyTorch. Setup adds only the torchvision build paired with that torch (the model's processor needs it even for text) and never replaces torch itself. The model itself sits in the standard Hugging Face cache. Files are split into code-aware chunks (functions, classes, and each method for Python; heading sections for Markdown; line windows elsewhere). They are embedded with the model card's CodeRetrieval prompts, truncated to 256 dimensions, and stored per project in `<userData>/semantic/indexes`. Only changed files are embedded again. Queries combine cosine similarity with a small keyword score. Other plugins can call `ide.semantic.query(text, {limit, similarTo})`. Tests use `PYIDE_SEMANTIC_BACKEND=fake`, a deterministic hashing embedder; `SEMANTIC_REAL=1 node verify/semantic.mjs` runs against the real model once `node verify/semantic-setup.mjs` has installed it.

## Database

`renderer/features/database`, `main/features/database.js` and `main/db/drivers.js` add PyCharm-style data sources. The driver table in `main/db/drivers.js` holds one entry per kind: SQLite (built in, Electron's `node:sqlite`), PostgreSQL (`pg`), and MySQL and MariaDB (both `mysql2`). Each entry carries its fields, default port, identifier quoting and an adapter with `query`, `schema` and `close`. External drivers install on demand with npm into `~\.pyide\db-drivers` (`PYIDE_DB_DRIVERS` overrides it). Data sources live in `<userData>/database/sources.json`. Passwords are encrypted with safeStorage and never reach the renderer, which only sees `hasPassword`. Errors cross IPC as `{ok: false, error, missingDriver}`.

The Database tool window (bottom, order 55) shows sources, schemas, tables, views and columns, loading a source's schema when it is expanded. A query console is a custom tab with a Monaco SQL editor over a result grid. Ctrl+Enter runs the selection or the statement at the caret; the splitter respects quotes, comments and `$tag$` bodies. Console text is saved under `<userData>/database/consoles/`. Opening a `.sqlite`, `.sqlite3` or `.db` file with a SQLite header adds it as a source. For server kinds, the data source dialog links to the Install Manager's Databases category. Tests: `verify/database.mjs` (ports 9600-9603); `DB_REAL=1` also installs the real `pg` driver.

## Install Manager

`renderer/features/installer`, `main/features/installer.js` and `main/installer/servers.js` add one tab (action `InstallManager`, Tools menu) for installing, updating and removing what a Python developer needs. An installable is a plain object pushed to `ide.installables`: `{id, category, name, description, size?, homepage?, status(), install(log, progress, signal), uninstall?, update?, start?, stop?, actions?: [{label, run, when?}], confirm?, confirmUninstall?}`, where `status()` resolves to `{installed, version?, running?, update?, detail?, available?, reason?}`. Built in are Python tools for the project interpreter (pip), portable PostgreSQL 18.6 and MariaDB 11.8.9 servers, and Git, Python 3.13 and Node.js through winget after a confirmation dialog. Other plugins add the PostgreSQL and MySQL drivers (database), EmbeddingGemma 2 (semantic) and Claude Code (terminal).

Main runs jobs in one queue per target (an interpreter's pip, winget, or one server), with cancel, streaming `installer:log` and `installer:progress`. Servers download with a pinned sha256 to `~\.pyide\servers\<name>-<version>` (`PYIDE_INSTALL_ROOT` overrides it), initialize with a generated password kept with safeStorage in `<userData>/installer/servers.json`, take the first free port from 5432 or 3306, run as children of the IDE and stop when it quits. A running server offers Add as Data Source, which calls `ide.database.addDataSource`. `PYIDE_INSTALLER_RUNNER` swaps the winget and detection runner for tests. Tests: `verify/installer.mjs` (ports 9620-9625); `INSTALLER_REAL=1` really downloads, starts, connects through the Database plugin, stops and removes both servers.

## AI runtime, completion and edits

`main/ai/runtime.js` owns the one private Python environment (`~\.pyide\semantic\venv`, reusing the system torch) and the JSON-lines sidecar client that semantic search and AI completion share.

AI completion (`renderer/features/ai-complete`, `main/features/ai-complete.js`, `main/ai/complete_server.py`, `main/ai/complete-text.js`) shows Cursor-style ghost text from a local fill-in-the-middle model: Qwen2.5-Coder 0.5B by default or 1.5B (Apache 2.0, Q8_0 GGUF on llama.cpp through `llama-cpp-python`). The prompt uses Qwen's repo-level format with the current file's prefix and suffix, up to two similar open-tab windows and one semantic search hit. Requests are debounced, a newer keystroke cancels the older request, and results are cached. `complete-text.js` cuts a suggestion at the end of the current block (the sidecar applies the same rule to stop early) and replaces auto-closed brackets the suggestion writes itself. Automatic suggestions skip comments, selections, multiple carets, mid-word positions and active suggest/snippet sessions. Settings live in Settings › AI › AI Completion. The models install from the Install Manager. `PYIDE_AI_COMPLETE_BACKEND=fake` (the test default) answers from a fixed rule table; `AI_COMPLETE_REAL=1 node verify/ai-complete.mjs` uses the real model (ports 9640-9641).

AI edits (`renderer/features/ai-edit`, `main/features/ai-edit.js`, `main/ai/claude.js`) call the Claude Code CLI headless with the user's subscription: `claude -p --output-format stream-json --model <haiku|sonnet|opus> --tools "" --max-turns 1 --safe-mode --no-session-persistence --system-prompt-file <file>`, run in an empty temp folder. `main/ai/claude.js` also owns the Claude Code lookup the terminal plugin uses (`PYIDE_CLAUDE_PATH` overrides it). Ctrl+I opens a prompt over the selection; the answer streams in as an inline diff whose hunks are accepted or rejected one by one, each accept being one undo step. Next edit suggestions (off by default, Settings › AI › Claude Edits) send the recent edits after a pause, at most one request per interval, and show the predicted edit with a gutter hint: Tab jumps, Tab applies, Esc dismisses. Tests use a fake CLI; `AI_EDIT_REAL=1 node verify/ai-edit.mjs` makes two real calls (ports 9650-9652).

## Git log and activity

The Git tool window (Alt+9) has three tabs. Log draws the commit graph (`layoutGraph` in `renderer/features/vcs/index.js`: each commit takes the lane waiting for it, its first parent continues the lane and merge parents branch out), marks merge commits, lists a merge's parents in the details, and filters by message/hash/author or by user, where "Me" is `git config user.name`. A filtered list shows dots only, since lines across hidden commits would mislead. Activity is `git reflog` for HEAD (`git:reflog`) as a timeline grouped by day: commits, amends, merges, checkouts, pulls, resets, finished rebases, cherry-picks and reverts each get a badge and a sentence from the `ACTIVITY` table, with git's own text (branch names, messages) kept as user data. Clicking an action's hash shows the commit in Log. Tests: `verify/vcs-log.mjs` (ports 9660-9661).