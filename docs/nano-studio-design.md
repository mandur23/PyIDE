# Nano Studio: design

PyIDE becomes **Nano Studio**, one installer with two apps chosen at every start:

- **Nano Studio Code**: today's IDE, unchanged in behavior.
- **Nano Studio Craft**: a launcher-like Minecraft app (in the spirit of the CurseForge app). It plays Minecraft with mods through the official Minecraft Launcher, joins servers with their mods synced automatically, and hosts servers with the existing server features.

The user's decisions (2026-10-31): the name is Nano Studio. It is a full rename (new app identity, migration from PyIDE). The game launches through the official Minecraft Launcher. The chooser appears at every start.

## 1. Modes (workstream A: core)

- **The process mode** is `code` or `craft`. Each process has exactly one mode, and running both means two processes; there is no single-instance lock, and that stays.
  - `--mode=code|craft` on the command line picks it without the chooser. Shortcuts and tests use this.
  - A file or folder on the command line (Open with, `nanostudio <path>`) means `code`.
  - Otherwise the **chooser** opens. It is a small frameless window (`renderer/chooser.html`, about 640x380) with two big cards: Nano Studio Code (code icon, "Python·웹 개발") and Nano Studio Craft (Minecraft icon, "마인크래프트 플레이·서버"). Clicking a card closes the chooser and opens the main window in that mode. Esc or closing the chooser quits.
  - Per the user's choice, the chooser has no "remember" option.
- **Plugins declare modes.** `plugin.json` gets `"modes": ["code"]` (the default when absent), `["craft"]` or `["code","craft"]`. `plugin-manager` filters by the process mode for both `rendererEntries` and `mainModules` (a main feature file that no plugin claims stays loaded in both modes, as today).
  - Craft needs: minecraft, port-sharing (and installer, which it depends on), run, notifications, problems?, settings, diagnostics, updater, and every required plugin. Run tabs show server consoles and job logs.
  - Craft does not need: editors' language features, debugger UI, VCS, database, AI chat, notebooks, and so on.
  - The rule: a plugin is in `craft` only if the Minecraft features call it or the app shell needs it. Required plugins must load in both modes.
- **The renderer knows its mode.** The main window URL carries `?mode=`, and `ide.appMode` is `'code'|'craft'`. In craft:
  - `body.app-craft` is set. The IDE chrome is hidden by CSS: main menu, project tool window and stripes, editor tab strip, breadcrumbs, run widget, and status-bar items other than notifications and the IDE-errors icon.
  - What remains is a full-window host, `#craftHost`, plus the bottom Run tool window (collapsed by default) for consoles.
  - The **craft workspace** is a folder, `%USERPROFILE%\Nano Studio Craft` (override `PYIDE_CRAFT_HOME` for tests). It is created if missing and opened as the project, so `ide.root` works for every Minecraft IPC, and it is trusted without the Trust question.
  - It has `servers/` (as today) and `instances/` (the launcher's).
  - `ide.emit('craftReady', {host})` fires once the workspace is open. The Minecraft plugin mounts its screen into `host` (workstream B2).
  - Window title: "Nano Studio Craft" (code mode: "<project> - Nano Studio Code").
- **Code mode** must look and behave exactly as PyIDE does now. The Minecraft plugin stays available in code (its plugin.json has both modes).

## 2. Launcher core (workstream B1: main side)

Files: new `main/minecraft/launcher.js` (plus helpers under `main/minecraft/`). Its IPC registration is called from `main/features/minecraft.js` (B1 owns the edits to that file).

**On disk, under the project root `root` (the craft workspace in craft):**
- `instances/<name>/` is the game directory of an instance: `mods/`, `config/`, saves, and `nano-instance.json` (`{name, mc, loader: 'vanilla'|'fabric'|'quilt'|'forge'|'neoforge', loaderVersion, created, lastPlayed, pack?: {url, sha1, files: [relative paths the pack installed]}, server?: {name, address}}`).
- `.launcher/` is the official launcher's work directory, its `--workDir`. It holds `versions/`, `libraries/`, `launcher_profiles.json`, and whatever the launcher itself downloads.
- `servers-list.json` holds the servers the user joins: `[{name, address, pack?, instance}]`.

**Loader install for the client, into `.launcher/versions`:**
- vanilla: nothing; the official launcher downloads it.
- fabric and quilt: the loader profile JSON from the meta service (`meta.fabricmc.net/v2/versions/loader/<mc>/<loader>/profile/json`, Quilt's equivalent) saved as `versions/<id>/<id>.json`.
- forge and neoforge: run the official installer in client mode into `.launcher` with the managed Java (`ensureJava`). Check the installers' real headless client option before relying on it (verify against the real Forge and NeoForge installers in an opt-in live test). If an installer has no headless client install, say so in the report and fall back to a clear error.
- Base URLs go through `sources.js` `base()`, so tests can replace them (`PYIDE_MC_SOURCES`).

**Per-instance version and profile, rewritten at every Play:**
- `versions/nano-<instance>/nano-<instance>.json` sets `inheritsFrom` to the loader version id (or the vanilla id).
- When joining a server it adds game arguments:
  - Minecraft 1.20 and later: `--quickPlayMultiplayer <host:port>`.
  - Older: `--server <host> --port <port>`.
- `launcher_profiles.json` gets one `custom` profile per instance, keyed `nano-<instance>`: `{name: "<instance> (Nano Studio)", type: "custom", lastVersionId: "nano-<instance>", gameDir: <instance dir>, javaArgs: "-Xmx<memory>", lastUsed: now, icon: "Grass"}`.
- Profiles the launcher or user added are kept. The file is merged, not overwritten.

**Launch:**
- Find the official launcher, in this order:
  1. `PYIDE_MC_LAUNCHER` (tests: a JSON argv, as with `PYIDE_BORE`).
  2. `%ProgramFiles(x86)%\Minecraft Launcher\MinecraftLauncher.exe`.
  3. `%ProgramFiles%\Minecraft Launcher\MinecraftLauncher.exe`.
  4. `%LOCALAPPDATA%\Programs\Minecraft Launcher\MinecraftLauncher.exe`.
- Start it detached with `--workDir <.launcher>`. The user signs in and presses Play there; the newest `lastUsed` profile is preselected.
- If it is not found, return `{code: 'noLauncher'}`. The UI then offers to open Mojang's download page. The app never installs it itself.
- Nothing in Nano Studio handles Microsoft account credentials.

**Pack sync (automatic mods when joining):**
- A server entry may carry a pack URL, a Modrinth `.mrpack`: the client pack that Nano Studio servers already make and share.
- At Play, the app downloads the pack. When its sha1 changed since the last sync, it:
  - reads `modrinth.index.json`;
  - downloads each client `files[]` entry with its hash checked;
  - extracts `overrides/` and `client-overrides/`;
  - removes files that the previous pack installed and the new one does not;
  - leaves files the user added untouched;
  - records `pack.files`.
- It checks that the instance's mc and loader match the pack's `dependencies` and changes the instance to match (the loader is installed again if needed).
- With AutoModpack in the pack, AutoModpack fetches the rest at the first join (it already works this way).

**IPC (all take `root` first; a job id streams `minecraft:log`, as other Minecraft jobs do):**
- `launcher:status(root)` returns `{launcher: path|null, workDir, instancesDir}`.
- `launcher:instances(root)` returns `[instance]`.
- `launcher:versions(kind)`: reuse `minecraft:versions` for mc lists, plus loader versions for client loaders.
- `launcher:create(root, {name, mc, loader, loaderVersion?}, job)` returns the instance.
- `launcher:fromPack(root, {url | file, name?}, job)` returns the instance. It covers a Modrinth modpack from the Market, or a server's pack.
- `launcher:remove(root, name)`. The renderer trashes the folder with `ide.api.trash`; this drops the profile and version.
- `launcher:servers(root)`, `launcher:saveServers(root, list)`.
- `launcher:join(root, {code} | {address, pack?, name?}, job)` returns `{server, instance}`. It parses a join code, creates or updates the instance from the pack (or asks for mc and loader when there is no pack: return `{needsVersion: true}`), and saves the server.
- `launcher:play(root, name, {server?}, job)` returns `{launched: true, launcher}` or throws `{code: 'noLauncher'}`. It syncs the pack, installs the loader, writes the version and profile, and starts the launcher.
- Join code text: `nanostudio:join?addr=<host:port>&pack=<url-encoded url>&name=<server name>`. It is pasted, never registered as a system protocol handler.

**Tests:** `verify/minecraft-launcher.mjs`, with stand-ins only:
- a local web server for Fabric meta, Modrinth CDN and a pack URL;
- a stand-in launcher (a node script that records its argv and copies `launcher_profiles.json` for checks);
- no real launcher, no real game, no login, no EULA.

It covers create (fabric), profiles merged, version JSON with quickPlay args, Play launching the stand-in with `--workDir`, a pack sync adding, updating and removing pack files while keeping a user mod, the join code parsed, and noLauncher. Add an opt-in `MC_LAUNCHER_LIVE=1` mode that installs real Fabric, Forge and NeoForge client loaders into a temp workDir; it is not in CI.

## 3. Craft UI (workstream B2: renderer)

Files: new `renderer/features/minecraft/craft.js` (loaded by `index.js` like the other files), plus `screen.js`, `style.css`, `locales/ko.json`, and `index.js` small hooks. B2 owns these after B1 (B1 does not touch the renderer).

In craft mode, on `craftReady`, the Minecraft screen mounts full-window as the app. In code mode the existing editor-tab screen stays as is, with the new pages too. Left navigation:

- **Play (플레이)**: instance cards (name, Minecraft and loader, mod count, last played) with a big **Play** button, Mods (the instance's mods folder list with enable/disable by `.disabled` rename and remove), Open Folder, Delete. Also **New Instance** (name, version, loader) and **From Modpack** (opens the Market on Modpacks; a modpack's button becomes "Install as Instance" in craft).
- **Servers to join (서버 참여)**: the saved servers with Join, which runs Play with the server and auto-syncs mods. Add Server takes a join code or an address. With an address only, it asks for version and loader, or finds them with a server list ping when it can (the version from the ping; Forge and NeoForge from `forgeData`).
- **My servers (내 서버)**: the existing server cards. In craft each card gets **Copy Join Code** (the public address from port sharing, plus the client pack share link) when the server is shared.
- **Market (마켓)**: existing.
- A banner when the official launcher is missing: "공식 Minecraft Launcher가 필요해요" with a button that opens the download page with `shell:openExternal`.
- Play shows progress in a balloon and the Run tab (job log), then "런처에서 로그인하고 플레이를 누르세요".

Everything in Korean (ko.json, i18n-static 0 missing). It uses the IDE's look (the same tokens as the server settings tab, `.mcset` style). Tests: extend `verify/minecraft-launcher.mjs` with a UI part in craft mode (`--mode=craft`, `PYIDE_CRAFT_HOME`): create an instance, Play with the stand-in launcher, add a server by join code, Join (pack synced, quickPlay args), and screenshots `craft-play.png` and `craft-servers.png`.

## 4. Rename (workstream C, after A and B2)

- **Identity:**
  - `package.json`: name `nano-studio`, productName `Nano Studio`, appId `dev.nanostudio.app`.
  - New MSI upgradeCode (a fresh GUID).
  - Artifacts `NanoStudio-Setup-${version}.exe` and `NanoStudio-${version}.msi`; shortcuts "Nano Studio".
  - The ProgID `NanoStudio.py` (build/installer.nsh, build/msi-project.js).
- **Release feed:** a new GitHub release tag `nano-studio` on mandur23/Portfolio-Nano- (`updateFeed`, `build.publish`, `scripts/release.mjs` TAG, regexes, install dir and process names). The version continues from 0.3.0.
  - Do not publish anything, and do not create the release. Only change the files.
  - Keep the rule that the Latest release on Portfolio-Nano- stays v1.4.3.
- **Migration:** on the first start of Nano Studio, when its userData has no `settings.json` and `%APPDATA%\PyIDE` exists, copy `settings.json`, `plugin-state.json`, `plugins/`, `interpreters.json`, `project-roots.json` and the Claude IDE settings. Leave logs and caches. Log it, and show a one-time notification "PyIDE 설정을 가져왔어요". Never move or delete the old folder.
- **Kept on purpose** (data compatibility):
  - project descriptors `pyide-*.json`;
  - the install root `~/.pyide` (toolchains, Java), so nothing is downloaded again;
  - `PYIDE_*` environment variables;
  - the `pyide-preview://` scheme and `--pyide-page`;
  - Gradle `pyide.*` properties.
  - Settings-sync import accepts both `product: 'PyIDE'` and `'Nano Studio'`.
- **Visible text** becomes Nano Studio: window titles, the welcome heading, About (renamed "Nano Studio 정보"), the updater, the Claude Code IDE lock name, the User-Agent (`NanoStudio/<ver>`), README, and the strings in locales.
  - User-visible "PyIDE" in renderer strings becomes "Nano Studio", including Korean strings.
  - Comments may stay unless they describe the product name.
- Tests that assert "PyIDE" titles or names are updated.

## 5. Out of scope now

- Launching the game directly with our own Microsoft sign-in, which needs Mojang's approval of an Azure app (aka.ms/mce-reviewappid). Leave a seam: `launcher.js` picks a launch method, and only `official` exists.
- A `nanostudio://` protocol handler.
- Telling existing PyIDE installs about the new app (a last PyIDE release with a notice).
- Publishing a release.

## Rules for every workstream

- Do not commit, push, or change git state. The lead reviews and commits.
- Make no system-wide changes: no registry, no global env, no protocol handlers, no subst drives.
- Install nothing on the machine, and never start the real Minecraft Launcher or game in tests.
- Never accept the Minecraft EULA, and never sign in to anything.
- Files use LF. Prefer exact edits. In `String.replace`, use function replacements.
- All UI text goes through `tr()` with Korean in the plugin's `locales/ko.json`. `node verify/i18n-static.mjs` must report 0 missing.
- Cleanup after tests:
  - Delete `verify/out/*` except `*-venv` and `downloads-cache`.
  - Run `node verify/clean.mjs --age 0`.
  - Remove `__pycache__` and temp files.
- Do not edit FEATURES.md or CHANGELOG.md. Return the text for them in your report; the lead merges it.
