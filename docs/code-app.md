# Nano Studio Code 개발 가이드

Nano Studio Code(PyCharm 스타일 Python IDE)를 고칠 때 보는 문서입니다. 공통 구조와 작업 순서는 [development.md](development.md), 이 앱에서 겪은 문제는 [pitfalls.md](pitfalls.md)의 "공통"과 "Code" 절에 있습니다. 기능별 상세 명세는 [FEATURES.md](../FEATURES.md)에서 기능 이름으로 찾습니다.

## 1. 실행

```bash
npm install
npm run vendor
npm start -- --mode=code
```

- `npm run vendor`가 debugpy와 ruff를 `vendor/`에 넣습니다. 없으면 디버그와 ruff 관련 테스트가 엉뚱한 단계에서 실패합니다.
- Python 3.10 이상이 PATH에 있어야 합니다. CI는 `py -3`과 `python`이 모두 3.13을 가리키게 합니다.
- 테스트의 `launch()`는 따로 지정하지 않으면 `--mode=code`로 띄웁니다.

## 2. 코어 지도

Code는 코어 위에 플러그인 약 75개가 올라간 구조입니다. 코어는 플러그인이 쓰는 API와 창의 뼈대를 맡습니다.

| 파일 | 맡은 일 |
| --- | --- |
| `renderer/core/ide.js` | `window.ide` API, 액션과 키맵(`KEYMAP_DEFAULTS`), 툴 윈도우와 스트라이프, 상태 표시줄, 대화상자(`ide.ui`), 설정, 프로젝트 열기, 프로젝트 트리 |
| `renderer/core/editors.js` | 편집기 탭과 그룹 분할, `ide.openFile`, 미리보기 탭, 분리 창, 창 닫기 대화상자(`#closeConfirmDialog`) |
| `renderer/core/mainmenu.js` | 메인 툴바(메인 메뉴, 프로젝트 위젯, 실행 위젯 자리), 시작 화면, 인터프리터 위젯 |
| `renderer/core/project-wizard.js` | New Project 마법사. 메인 쪽은 `main/new-project.js` |
| `renderer/core/notifications.js` | 백그라운드 작업(`ide.tasks`)과 알림 |
| `renderer/core/diagnostics.js` | 렌더러 예외와 플러그인 로드 실패를 메인에 보고. 모든 창에서 가장 먼저 로드 |
| `renderer/core/i18n.js` | `tr()`과 사전 합치기 |
| `renderer/core/theme.js`, `styles.css` | PyCharm 색과 기본 스타일 |
| `renderer/core/file-icons.js`, `icons*.js` | 파일 아이콘과 UI 아이콘. 그림 데이터는 `tools/`의 생성기가 만듭니다 |
| `main.js` | 인터프리터 목록(`py:interpreters`), 프로세스 실행, 모드 선택 |
| `main/lsp-server.js` | 언어 서버 클라이언트. Pyright와 다른 언어 서버가 같이 씁니다 |
| `main/project-watch.js` | 바깥에서 바뀐 프로젝트 파일 알림 |
| `main/worker-host.js` | 디스크를 많이 읽는 기능을 워커 스레드에서 실행 |
| `main/text-codec.js` | 문서의 인코딩(CP949 등) 유지 |
| `main/trust.js` | 안전 모드. 신뢰하지 않은 프로젝트에서 자동 실행을 막습니다 |

## 3. 자주 고치는 영역

### 프로젝트 트리 (`renderer/core/ide.js`)

- 보이는 행만 DOM으로 만듭니다(`#tree .node`, 한 행 24px). 행을 찾는 코드는 먼저 `ide.revealInTree(path)`로 스크롤합니다.
- `rowNode`가 행을 그립니다. 폴더의 꺾쇠 SVG는 한 번 만들어 복사하고, 열린 폴더는 `.arrow.open`입니다. 안내선은 행의 `--guides` 너비와 `.node::before`의 반복 그라데이션입니다.
- 선택은 `selected`, `alsoSelected`, `anchor`입니다. 여러 행을 다루는 동작은 `operands(entry, 조건)`으로 대상을 얻고, 이동은 `movableEntry`, 삭제는 `deletableEntry`가 조건입니다.
- 옮기기는 `moveEntries(entries, dir)`가 한 번 묻고 `ide.treeMovers`를 부릅니다. refactor 플러그인이 Python 모듈의 import를 고치는 mover를 넣습니다(`refactor.moveImports`: auto, ask, never).
- 키 처리는 `treeKey`입니다. 파일을 클릭해 열 때는 `focus: false`라 키보드가 트리에 남습니다.
- 테스트: `verify/tree.mjs`. 키보드 동작은 CDP 마우스 클릭 뒤에 확인합니다.

### 편집기 탭과 그룹 (`renderer/core/editors.js`)

- `ide.openFile(path, {line, col, focus, group, preview})`. `preview`는 `editor.previewTab` 설정이 켜져 있을 때만 미리보기 탭이 됩니다.
- 긴 이름은 `ide.util.fileLabel`이 확장자를 남기고 줄입니다. 탭은 `--tab-name-max`(220px)에서 멈춥니다.
- 창 닫기: 메인(`main/windows.js`)이 저장 안 한 파일(`window:setDirty`)과 실행 중인 프로그램(`window:setBusy`)을 알고, 있으면 `window:confirmClose`를 보냅니다. 렌더러가 대화상자를 띄우고 `window:closeNow`로 닫습니다.
- 테스트: `verify/editors.mjs`, `verify/session.mjs`, `verify/close-running.mjs`.

### 실행, 디버그, 테스트 (run, debugger, tests)

- 실행 구성 타입은 `ide.run.registerType`으로 등록합니다. 타입이 없는 저장된 구성(플러그인이 꺼졌거나 다른 모드의 타입)도 처리해야 합니다.
- run 플러그인의 `reportBusy()`가 실행 중인 세션 이름을 메인에 알립니다. 새 실행 방식을 만들면 세션이 `busy`에 잡히는지 확인합니다.
- Python 디버그는 `vendor/`의 debugpy, Java는 JDWP입니다. 디버그 포트는 다른 로컬 계정이 먼저 접속할 수 있다는 문제가 남아 있습니다.
- 테스트: `verify/run-automation.mjs`, `verify/debugger.mjs`, `verify/spring-boot.mjs`, `verify/flow-coding.mjs`.

### 언어 기능 (lsp)

- Pyright는 `main/features/lsp.js`의 사양으로 `main/lsp-server.js`가 띄웁니다. 렌더러는 `ide.lsp`를 씁니다.
- Pyright 진단은 영어 문구가 아니라 `code`와 범위로 판단합니다. UI 언어로 진단이 나오기 때문입니다.
- 준비 직후의 빈 `documentSymbol` 답은 캐시하지 않습니다.
- 테스트: `verify/lsp.mjs`, `verify/i18n-lsp.mjs`.

### 리팩터링 (refactor)

- rope로 이름 변경, 추출, 인라인, 이동을 합니다. 파일을 고치기 전에 `ide.localHistory.checkpoint`를 남깁니다.
- 트리에서 옮긴 Python 파일의 import 수정은 기본이 자동이고, 알림에서 되돌릴 수 있습니다. rope가 없으면 경고 후 import 없이 옮깁니다.
- 테스트: `verify/refactor.mjs`(rope가 든 venv를 `verify/out/refactor-venv`에 만들어 다시 씁니다), `verify/rename-module.mjs`.

### HTML과 템플릿 미리보기 (viewers)

- `.html` 파일은 HTML 뷰어(편집기와 미리보기)로 열립니다. 미리보기는 `main/features/viewers.js`가 `pyide-preview://` 주소로 프로젝트 폴더를 웹 서버처럼 내줍니다.
- 루트 경로(`/css/x.css`)가 프로젝트 루트에 없으면 미리보는 페이지의 폴더와 그 위 폴더, 그 안의 `static`, `public`, `resources`에서 찾습니다(`fallbackBases`). Spring Boot의 `src/main/resources/static`, Flask의 `static/`이 여기서 잡힙니다.
- Django와 Jinja2 템플릿은 템플릿 편집기로 열고, 미리보기는 따로 여는 탭(`Preview Template`, 편집기 오른쪽 위 버튼)입니다. 뷰어 안의 편집기는 `ide.editor`가 아니라서 템플릿 기능이 깨지기 때문입니다.
- 템플릿을 페이지로 합치는 일은 `main/template-preview.js`가 합니다. Jinja2/Django는 `renderTemplate`, Thymeleaf는 `renderThymeleaf`입니다. 서버 값은 실행하지 않습니다.
- 테스트: `verify/html-preview.mjs`, `verify/html-preview-app.mjs`, `verify/html-preview-templates.mjs`.

### 다이어그램과 ERD (diagrams, database)

- `renderer/features/diagrams/index.js`의 `layoutGraph`가 배치합니다. ERD는 모델이 `layout: 'erd'`를 주고, 외래 키로 열을 나누며 선은 테이블 사이 통로로만 지나갑니다.
- 색은 `--dg-*` 변수입니다. 키 아이콘은 `--dg-pk`, `--dg-fk`, 선 색은 `--dg-k0`~`--dg-k7`입니다.
- 테스트: `verify/database-erd.mjs`, `verify/diagrams.mjs`. 선이 있는지만 보지 말고 상자를 지나지 않는지까지 봅니다.

## 4. 기능 지도

플러그인별 메인 모듈과 대표 테스트입니다. 각 `plugin.json`에서 뽑았습니다. "Craft에도"는 Craft에서도 로드되는 플러그인입니다.

### 편집과 언어 기능

| 플러그인 | 이름 | 메인 모듈 | 대표 테스트 |
| --- | --- | --- | --- |
| `lsp` | Python Language Support (Pyright) | `main/features/lsp.js` | `verify/lsp-type-severity.mjs`, `verify/lsp.mjs` |
| `language-servers` | Language Servers | `main/features/language-servers.js` | `verify/language-servers-live.mjs`, `verify/language-servers.mjs` |
| `java-lsp` | Java Language Support (Eclipse JDT LS) | `main/features/java-lsp.js` | `verify/java-lsp.mjs` |
| `language-basics` | Language Basics | - | - |
| `semantic-highlight` | Semantic Highlighting | `main/features/semantic-highlight.js` | `verify/semantic-highlight.mjs` |
| `inlay-hints` | Inlay Hints | - | `verify/inlay-hints.mjs` |
| `code-vision` | Code Vision | `main/features/code-vision.js` | `verify/code-vision-perf.mjs`, `verify/code-vision.mjs` |
| `editor-assists` | Editor Assists | - | `verify/editor-assists.mjs` |
| `live-templates` | Live Templates | - | `verify/live-templates.mjs` |
| `emmet` | Emmet | - | `verify/emmet.mjs` |
| `html-autoclose` | HTML Tag Closing | - | `verify/html-autoclose.mjs` |
| `spellcheck` | Spell Checker | `main/features/spellcheck.js` | `verify/spellcheck.mjs` |
| `js-tools` | Prettier and ESLint | `main/features/js-tools.js` | `verify/js-tools.mjs` |
| `data-formats` | Data Formats | - | `verify/data-formats.mjs` |
| `line-separators` | Line Separators | - | - |
| `regex-check` | Regular Expression Checker | `main/features/regex-check.js` | `verify/regex-check.mjs` |

### 탐색과 검색

| 플러그인 | 이름 | 메인 모듈 | 대표 테스트 |
| --- | --- | --- | --- |
| `search-nav` | Search and Navigation | `main/features/search.js` | `verify/search-nav.mjs` |
| `search-everywhere` | Search Everywhere | - | `verify/search-everywhere.mjs` |
| `navigation-bar` | Breadcrumbs and Call Hierarchy | - | - |
| `type-hierarchy` | Type Hierarchy | `main/features/type-hierarchy.js` | `verify/type-hierarchy.mjs` |
| `goto-test` | Go to Test | - | `verify/goto-test-edges.mjs` |
| `bookmarks` | Bookmarks | - | - |

### 리팩터링과 코드 수정

| 플러그인 | 이름 | 메인 모듈 | 대표 테스트 |
| --- | --- | --- | --- |
| `refactor` | Refactorings | `main/features/refactor.js` | `verify/refactor.mjs` |
| `tooling` | Ruff Formatter and Linter | `main/features/tooling.js` | `verify/tooling.mjs` |
| `type-fixes` | Type Warning Fixes | - | `verify/type-fixes.mjs` |
| `code-generation` | Quick Fixes and Code Generation | - | `verify/code-generation-sidecar.mjs`, `verify/code-generation.mjs` |
| `error-help` | Error Explanations | - | `verify/error-help.mjs` |
| `import-install` | Install Missing Packages | `main/features/import-install.js` | `verify/import-install-run.mjs`, `verify/import-install.mjs` |
| `file-templates` | File and Code Templates | `main/features/file-templates.js` | - |

### 실행, 디버그, 테스트

| 플러그인 | 이름 | 메인 모듈 | 대표 테스트 |
| --- | --- | --- | --- |
| `run` (Craft에도) | Run Configurations | `main/features/run.js` | `verify/run-automation.mjs`, `verify/run-debug-edges.mjs`, `verify/run-roots-edges.mjs`, `verify/run-roots-wiring.mjs` |
| `debugger` | Debugger | `main/features/debug.js`, `main/features/debug-attach.js`, `main/features/debug-jvm.js`, `main/features/debug-jvm-eval.js` | `verify/debugger-exceptions.mjs`, `verify/debugger-input.mjs`, `verify/debugger-subprocess.mjs`, `verify/debugger-values.mjs` |
| `tests` | Python Test Runner | `main/features/tests.js` | `verify/tests-debug-run.mjs`, `verify/tests-debug-target.mjs`, `verify/tests-tree-menu.mjs` |
| `coverage` | Code Coverage | `main/features/coverage.js` | `verify/coverage-profile.mjs` |
| `profiler` | Python Profiler | `main/features/profiler.js` | - |
| `pyconsole` | Python Console | `main/features/pyconsole.js` | `verify/pyconsole.mjs` |
| `rerun-on-save` | Rerun on Save | - | `verify/rerun-on-save.mjs` |
| `run-anything` | Run Anything | - | - |
| `terminal` (Craft에도) | Terminal | `main/features/terminal.js` | `verify/terminal-pipes.mjs`, `verify/terminal-split.mjs`, `verify/terminal-venv.mjs`, `verify/terminal.mjs` |

### 인터프리터와 환경

| 플러그인 | 이름 | 메인 모듈 | 대표 테스트 |
| --- | --- | --- | --- |
| `venv-setup` | Virtual Environment Setup | `main/features/venv-setup.js` | - |
| `packages` | Python Packages | `main/features/packages.js` | - |
| `requirements-sync` | Sync Python Requirements | `main/features/requirements-sync.js` | `verify/requirements-sync.mjs` |
| `remote-interp` | Remote Interpreters | `main/features/remote-interp.js` | `verify/remote-interp.mjs` |
| `toolchains` | Java and C/C++ | `main/features/toolchains.js` | `verify/toolchains.mjs` |
| `spring-boot` | Spring Boot | `main/features/spring-initializr.js` | `verify/spring-boot.mjs` |
| `dotenv` | .env Files | - | `verify/dotenv.mjs` |
| `frameworks` | Django, Flask and FastAPI | `main/features/frameworks.js` | `verify/frameworks.mjs` |
| `installer` (Craft에도) | Install Manager | `main/features/installer.js` | `verify/installer-python.mjs`, `verify/installer.mjs` |
| `exe-builder` | Build Executable | `main/features/exe-builder.js` | `verify/exe-builder-live.mjs`, `verify/exe-builder.mjs` |
| `vulnerabilities` | Vulnerable Packages | `main/features/vulnerabilities.js` | `verify/vulnerabilities.mjs` |

### 버전 관리와 기록

| 플러그인 | 이름 | 메인 모듈 | 대표 테스트 |
| --- | --- | --- | --- |
| `vcs` | Git Integration | `main/features/git.js` | `verify/vcs-daily.mjs`, `verify/vcs-force-push.mjs`, `verify/vcs-ignored.mjs`, `verify/vcs-log-actions.mjs` |
| `vcs-merge` | Git Merge, Rebase and Stash | - | `verify/vcs-merge.mjs` |
| `vcs-checks` | Commit Checks | `main/features/vcs-checks.js` | - |
| `github` | GitHub | `main/features/github.js` | `verify/github.mjs` |
| `local-history` | Local History | `main/features/local-history.js` | - |

### 데이터와 문서 보기

| 플러그인 | 이름 | 메인 모듈 | 대표 테스트 |
| --- | --- | --- | --- |
| `database` | Database Tools and SQL | `main/features/database.js` | `verify/database-completion.mjs`, `verify/database-erd.mjs`, `verify/database-nosql.mjs`, `verify/database-sql-files.mjs` |
| `diagrams` | Python Class Diagrams | `main/features/diagrams.js` | `verify/diagrams.mjs` |
| `sciview` | Scientific Data View and Plots | `main/features/sciview.js` | - |
| `notebook` | Jupyter Notebooks | `main/features/notebook.js` | `verify/notebook.mjs` |
| `viewers` | File Viewers | `main/features/viewers.js` | `verify/viewers.mjs` |
| `http-client` | HTTP Client | `main/features/http-client.js` | `verify/http-client.mjs` |
| `compare` | File Compare | `main/features/compare.js` | `verify/compare-files.mjs` |
| `visual-script` | Visual Scripting | `main/features/visual-script.js` | `verify/visual-script-codegen.mjs`, `verify/visual-script-debug.mjs`, `verify/visual-script-editor.mjs`, `verify/visual-script-from-python.mjs` |

### AI

| 플러그인 | 이름 | 메인 모듈 | 대표 테스트 |
| --- | --- | --- | --- |
| `ai-chat` | AI Chat (Claude) | `main/features/ai-chat.js` | `verify/ai-chat.mjs` |
| `ai-complete` | AI Completion (Qwen2.5-Coder) | `main/features/ai-complete.js` | `verify/ai-complete.mjs` |
| `ai-edit` | AI Edits (Claude) | `main/features/ai-edit.js` | `verify/ai-edit.mjs` |
| `ai-generate` | AI Actions: Documentation and Tests (Claude) | `main/features/ai-generate.js` | `verify/ai-generate.mjs` |
| `semantic` | Semantic Code Search (EmbeddingGemma 2) | `main/features/semantic.js` | `verify/semantic-highlight.mjs`, `verify/semantic-setup.mjs`, `verify/semantic.mjs` |
| `claude-ide` | Claude Code IDE Integration | `main/features/claude-ide.js` | `verify/claude-ide.mjs` |

### 작업 공간과 앱 셸

| 플러그인 | 이름 | 메인 모듈 | 대표 테스트 |
| --- | --- | --- | --- |
| `workspace` | My Workspace | `main/features/workspace.js` | `verify/workspace.mjs` |
| `scratches` | Scratch Files | `main/features/scratches.js` | `verify/scratches.mjs` |
| `recovery` | Crash Recovery | `main/features/recovery.js` | `verify/recovery-main.mjs`, `verify/recovery.mjs` |
| `autosave` | Auto Save | - | `verify/autosave.mjs` |
| `layouts` | Tool Window Layouts | - | - |
| `settings` (Craft에도) | Settings | - | `verify/settings-instances.mjs`, `verify/settings-search.mjs`, `verify/settings-sync.mjs`, `verify/settings.mjs` |
| `settings-sync` | Settings Export and Import | `main/features/settings-sync.js` | `verify/settings-sync.mjs` |
| `clipboard-history` | Paste from History | `main/features/clipboard-history.js` | - |
| `file-watchers` | File Watchers | `main/features/file-watchers.js` | - |
| `power-save` | Power Save Mode | - | - |
| `appearance-modes` | Appearance Modes | `main/features/appearance-modes.js` | `verify/appearance-modes.mjs` |
| `project-roots` (Craft에도) | Project Structure | `main/features/project-roots.js` | - |
| `problems` (Craft에도) | Problems View | - | - |
| `notifications` (Craft에도) | Notifications | `main/features/notifications.js` | `verify/notifications-log.mjs` |
| `diagnostics` (Craft에도) | Diagnostics | `main/features/diagnostics.js` | `verify/diagnostics.mjs` |
| `updater` (Craft에도) | Updates | `main/features/updater.js` | `verify/updater.mjs` |
| `port-sharing` (Craft에도) | Ports | `main/features/port-sharing.js` | `verify/port-sharing-bore-live.mjs`, `verify/port-sharing-core.mjs`, `verify/port-sharing-live.mjs`, `verify/port-sharing.mjs` |

## 5. 테스트 팁

- 테스트용 venv와 내려받은 파일은 `verify/out/*-venv`, `verify/out/downloads-cache`에 쌓아 다시 씁니다. 정리할 때 남깁니다.
- 실제 Python 프로그램을 돌리는 테스트는 PC의 Python에 따라 결과가 다를 수 있습니다. 실패하면 인터프리터 버전부터 봅니다.
- 작업 트리(git worktree)에서 테스트하려면 `node_modules`, `vendor`, 필요한 `verify/out/*-venv`를 정션으로 걸고, 지우기 전에 `cmd /c rmdir`로 끊습니다.
- 성능 테스트(`verify/perf.mjs`)는 다른 테스트와 함께 돌리면 시간 검사가 틀립니다. 실패하면 혼자 다시 돌립니다.
