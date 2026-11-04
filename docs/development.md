# 개발 가이드 (Code와 Craft 공통)

Nano Studio를 고칠 때 먼저 읽는 문서입니다. 구조, 기능을 만드는 방법, 코딩 규칙, 테스트, 커밋과 릴리스 순서를 다룹니다. 앱별 내용은 [code-app.md](code-app.md)와 [craft-app.md](craft-app.md), 겪은 문제와 규칙은 [pitfalls.md](pitfalls.md), 기능과 API의 상세 명세는 [FEATURES.md](../FEATURES.md)에 있습니다.

## 1. 한눈에 보기

- Windows 전용 Electron 45 앱입니다. 편집기는 Monaco입니다.
- 설치본 하나에 앱이 두 개 있습니다. 프로세스마다 모드가 하나입니다.
  - `code`: Nano Studio Code. PyCharm 스타일 Python IDE입니다.
  - `craft`: Nano Studio Craft. 공식 Minecraft Launcher로 플레이하고 서버를 여는 앱입니다.
  - `--mode=code|craft`로 고르고, 경로 인자가 있으면 code입니다. 둘 다 없으면 시작 화면(`renderer/chooser.html`)이 뜹니다.
- 프로세스는 셋입니다.
  - 메인: `main.js`와 `main/`. 파일, 프로세스, 네트워크, 창을 맡습니다.
  - 프리로드: `preload.js`. IDE 페이지(`renderer/index.html`)에만 `window.api`를 줍니다.
  - 렌더러: `renderer/core/`(코어)와 `renderer/features/<기능>/`(플러그인). 샌드박스이고 CSP가 있습니다.

## 2. 저장소 구조

| 경로 | 내용 |
| --- | --- |
| `main.js` | 앱 시작, 모드 선택, 프로세스 실행(`startProcess`), 인터프리터 목록, 종료 관문(`holdQuit`) |
| `main/windows.js` | 메인 창과 분리 창, 시작 화면, 닫기 전 확인(저장 안 한 파일, 실행 중인 프로그램) |
| `main/plugin-manager.js` | 플러그인 찾기, 모드 거르기, 켜고 끄기, 설치 |
| `main/features/<기능>.js` | 기능의 메인 모듈. `register(ctx)`로 IPC를 등록합니다 |
| `main/trust.js`, `main/security.js`, `main/program-env.js` | 안전 모드, 창 탐색과 권한 차단, 자식 프로세스 환경 |
| `main/minecraft/`, `main/bore-*.js` | Craft의 서버, 런처, 플레이어, 비공개 공유 |
| `renderer/core/ide.js` | `window.ide` API, 액션과 키맵, 프로젝트 트리, 툴 윈도우, 대화상자, 설정 |
| `renderer/core/editors.js` | 편집기 탭, 그룹 분할, `ide.openFile`, 창 닫기 대화상자 |
| `renderer/features/<기능>/` | 플러그인: `plugin.json`, `index.js`, `style.css`, `locales/ko.json` |
| `renderer/locales/ko.json` | 코어와 공용 문구의 한국어 |
| `verify/` | 테스트(`<이름>.mjs`), 공용 도구 `lib.mjs`, 고정 프로젝트 `fixtures/` |
| `scripts/release.mjs` | 릴리스 전 과정 |
| `tools/` | 아이콘 생성기, NanoBridge 플러그인 소스 |
| `docs/` | 이 문서들과 Craft 설계 문서 |

## 3. 기능(플러그인) 만들기

기능 `foo`는 다음 파일로 이루어집니다. 자세한 규칙은 FEATURES.md의 "Layout of a feature named `foo`"와 "Plugins"에 있습니다.

- `renderer/features/foo/plugin.json`: `{id, name, version, vendor, description, main?, depends?, modes?, required?, requiredIn?}`.
  - `modes`의 기본값은 `["code"]`입니다. Craft에도 필요하면 `["code", "craft"]`, Craft 전용이면 `["craft"]`를 씁니다.
  - `required`는 모든 모드에서 로드됩니다. 한 모드에서만 끌 수 없게 하려면 `requiredIn`을 씁니다.
  - `main`에 적은 파일은 `main/features/`에서 찾습니다. 꺼진 플러그인은 렌더러와 메인 모듈 모두 로드되지 않습니다.
- `renderer/features/foo/index.js`: IIFE로 감싸고 전역 `ide`를 씁니다. 모든 플러그인 스크립트가 차례로 실행되고, `depends`가 먼저 로드됩니다.
- `main/features/foo.js`: `module.exports = { register(ctx) { ... } }`. 채널 이름은 `foo:동작`입니다.
- `renderer/features/foo/style.css`: 있으면 자동으로 로드됩니다. `renderer/core/styles.css`의 변수(`--gray1`~`--gray12`, `--blue6`, `--green6`, `--red`, `--yellow`, `--mono`)를 씁니다.
- `renderer/features/foo/locales/ko.json`: 영어 원문을 키로 한 한국어입니다.
- `verify/foo.mjs`와 `verify/fixtures/foo/`: 실제 앱을 띄우는 테스트입니다.

자주 쓰는 렌더러 API입니다. 전체 목록은 FEATURES.md의 "Renderer API"와 "Cross-feature APIs"에 있습니다.

- 액션: `ide.registerAction({id, title, keys, run, when, context})`. 키는 PyCharm 기본 키맵을 따르고 다른 기능의 키를 빼앗지 않습니다. 화면에 단축키를 쓸 때는 `ide.keymap.label(id)`를 읽습니다.
- 툴 윈도우: `ide.registerToolWindow({id, title, icon, side, order, mount})`. 아이콘은 `ide.icon(name)`의 이름입니다.
- 대화상자와 목록: `ide.ui.dialog`, `ide.ui.pick`, `ide.ui.contextMenu`, `ide.ui.confirm`, `ide.ui.listKeys`.
- 설정: `ide.settings.get/set`, 설정 페이지는 `ide.settingsPages`에 넣습니다. Craft에도 보이려면 `craft: true`입니다.
- 이벤트: `ide.on('projectOpened' | 'fileSaved' | 'settingsChanged' | ...)`. 해제 함수를 돌려줍니다.
- 프로세스: 메인의 `ctx.startProcess`가 돌려준 id를 `ide.proc.attach(id, {data, exit})`에 넘깁니다.
- 다른 플러그인 API(`ide.lsp`, `ide.run`, `ide.debugger`...)는 없을 수 있습니다. `?.`로 부릅니다.

## 4. 코딩 규칙

규칙마다 이유가 된 사건은 [pitfalls.md](pitfalls.md)에 있습니다.

### 메인 프로세스

- 프로젝트의 파일이나 설정을 실행하거나 해석하는 IPC는 신뢰부터 확인합니다(`trust.isTrusted(root)`, `guard()`).
- 경로는 실제 경로(`realpath`)로 판단합니다. 프로젝트 안인지는 `rel === '..' || rel.startsWith('..' + path.sep)`와 `path.isAbsolute`로 봅니다. 8.3 이름, junction, 끝의 점을 고려합니다.
- 다른 프로그램에 넘기는 경로는 `ctx.unpackedDir` 아래여야 하고 `package.json`의 `build.asarUnpack`에 있어야 합니다.
- 화면이 분기해야 하는 결과는 throw하지 않고 값으로 돌려줍니다. IPC 오류는 메시지만 넘어갑니다.
- 파일 쓰기는 임시 파일에 쓰고 이름을 바꿉니다. 읽기 실패와 빈 파일을 구분합니다.
- 시스템 전체를 바꾸지 않습니다. 레지스트리, 전역 환경 변수, 프로토콜 핸들러, subst 드라이브를 건드리지 않습니다.
- 비밀값은 인자와 로그에 넣지 않습니다. 새 형식이면 `main/diagnostics/redact.js`에 추가합니다.

### 렌더러

- CSP 때문에 인라인 스크립트, 인라인 이벤트 핸들러, `eval`, 네트워크 `fetch`를 쓸 수 없습니다. 네트워크는 메인 모듈을 거칩니다.
- 외부 값은 `textContent`(`ide.util.el(tag, cls, text)`)로 넣습니다. `innerHTML`에 넣지 않습니다.
- 입력칸이 있는 영역을 통째로 다시 그리지 않습니다. 폼은 한 번 만들고 목록만 다시 그립니다.
- 크기 감시는 `ide.util.observeSize`를 씁니다. 긴 목록은 보이는 행만 DOM으로 만듭니다.
- 아이콘은 `ide.icon(name)`, 파일 아이콘은 `ide.fileIcon(name, {dir})`를 씁니다.
- 색은 CSS 변수로 쓰고 다크와 라이트를 모두 확인합니다. 라이트 값은 `renderer/features/settings/style.css`와 `renderer/core/styles.css`의 `:root[data-theme="light"]`에 있습니다.
- 파일을 열 때 키보드를 옮기지 않아야 하면 `ide.openFile(path, {focus: false})`를 씁니다.

### 코드 모양

- 주변 코드의 이름, 주석 밀도, 관용구를 따릅니다. 주석은 코드로 보이지 않는 이유만 씁니다.
- `String.replace`에는 함수를 넘깁니다. 치환 문자열의 `$`가 해석됩니다.
- 새 파일은 LF입니다. 이미 CRLF로 커밋된 파일은 CRLF를 지킵니다.

## 5. 번역

- 원문은 영어이고 `tr('Run {name}', {name})`으로 번역합니다. 정적 마크업은 `data-i18n`을 씁니다.
- 한국어는 플러그인의 `locales/ko.json`에 넣습니다. 두 앱이 함께 쓰는 문구는 `renderer/locales/ko.json`에 넣습니다. 사전은 모드별로 합쳐지므로 Code 전용 플러그인의 문구는 Craft에 없습니다.
- 사용자 데이터(코드, 파일 이름, 경로, 출력)는 번역하지 않습니다. 용어는 PyCharm 한국어 팩을 따릅니다.
- Craft 문구는 -요 말투입니다. 이름 뒤에 조사를 붙이지 않습니다.
- 바꾼 뒤 `node verify/i18n-static.mjs`가 누락 0개여야 합니다.

## 6. 테스트

### 실행

- 사용 중인 PC에서는 숨겨진 데스크톱에서 하나씩 돌립니다. `-Out`은 저장소 기준 상대 경로입니다.

  ```bash
  powershell -NoProfile -ExecutionPolicy Bypass -File verify/on-desktop.ps1 -Out verify/out/tree.log -TimeoutMinutes 15 node verify/tree.mjs
  ```

- 결과는 로그 끝의 `N/M passed`와 `FAIL` 줄로 봅니다. 통과 수가 비어 있으면 테스트가 돌지 않은 것입니다.
- 일반 Node 테스트(`*-core.mjs`, `redact.mjs` 등)는 `node verify/<이름>.mjs`로 바로 돌립니다.
- CI 러너와 비슷하게 돌리려면 `PYIDE_TEST_VIEWPORT=1024x720 PYIDE_TEST_CPU=2`를 줍니다.

### 작성

- `verify/lib.mjs`의 `launch({fixture, port, mode, lang, env, projectDir, ...})`가 임시 프로젝트, 임시 사용자 데이터, CDP 포트로 앱을 띄웁니다. 돌려받는 도구는 `js`, `until`, `press`, `type`, `click`, `cdp`, `shot`, `check`, `finish`, `close`입니다.
- 포트는 테스트마다 고유합니다. 새 포트는 `grep -rn "port: 9762" verify`처럼 먼저 찾아봅니다.
- 사용자가 하는 그대로 시험합니다. 클릭은 `click(selector)`나 `cdp('Input.dispatchMouseEvent', ...)`로 실제로 누르고, 키는 `press`로 보냅니다. DOM `.click()`과 스크립트 `focus()`는 포커스와 배치 문제를 숨깁니다.
- 보이는지는 `elementFromPoint`와 스크린샷으로 확인합니다. overflow 검사만으로는 부족합니다.
- 테스트를 고치기 전 코드로 한 번 돌려 실패하는지 봅니다. 앱 파일 하나만 `git show HEAD:<파일>`로 되돌리고 테스트한 뒤 원래대로 복사합니다.
- 영어가 기본입니다. 한국어는 `lang: 'ko-KR'`로 띄우고 `verify/i18n-lib.mjs`를 씁니다.
- CI에 넣으려면 `.github/workflows/ci.yml`에 같은 모양의 단계를 추가합니다. 네트워크, AI 모델, DB, Docker, WSL이 필요한 테스트는 넣지 않습니다.

### 정리

- 테스트가 끝나면 `verify/out/`에서 `*-venv`와 `downloads-cache`를 뺀 나머지를 지우고 `node verify/clean.mjs --age 0`을 돌립니다. 다른 세션이 테스트 중이면 `--age 15`를 씁니다.
- 직접 만든 탐색용 스크립트, `__pycache__`, 임시 폴더도 지웁니다.

## 7. 작업 순서

1. [pitfalls.md](pitfalls.md)의 공통 절과 작업할 앱의 절을 읽습니다.
2. 고칠 곳을 찾습니다. FEATURES.md에서 기능 이름으로 찾으면 파일과 테스트가 나옵니다.
3. 버그는 먼저 실제 앱에서 재현합니다. 짧은 탐색 스크립트를 `verify/out/`에 두고 `launch()`로 띄우면 빠릅니다.
4. 고치고, 바꾼 동작을 확인하는 검사를 그 기능의 테스트에 넣습니다. 고치기 전 코드에서 실패하는지 봅니다.
5. 그 기능의 테스트와 같은 영역을 쓰는 테스트를 하나씩 돌립니다. 화면이 바뀌면 다크와 라이트 화면을 캡처해 직접 봅니다.
6. 문서를 고칩니다. 동작은 FEATURES.md의 그 기능 절에, 새로 겪은 문제는 pitfalls.md에 한 줄로 넣습니다. CHANGELOG.md는 릴리스할 때 씁니다.
7. 테스트 잔여물을 정리합니다.
8. 커밋은 요청이 있을 때만 합니다. 커밋 메시지 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`을 붙입니다.

## 8. CI와 릴리스

### CI

- `.github/workflows/ci.yml`이 master 푸시와 PR마다 약 150개 단계를 차례로 돌립니다. 약 70분 걸립니다.
- 같은 브랜치에 새 푸시가 오면 진행 중인 실행이 취소됩니다. 결과가 필요하면 끝날 때까지 푸시하지 않습니다.
- 실패하면 `gh run view <id> --log-failed`로 FAIL 줄을 봅니다. 로컬에서 그 테스트만 다시 돌려 재현되는지 확인합니다. 재현되지 않으면 `gh run rerun <id> --failed`로 다시 돌립니다.

### 릴리스

1. `CHANGELOG.md` 맨 위에 `## <버전>` 절을 쓰고 커밋, 푸시합니다. 이 절이 릴리스 노트가 됩니다. 버전은 package.json보다 높아야 하고, 미리 올리지 않습니다.
2. CI 결과를 확인합니다. 실패가 있으면 원인을 보고, 그대로 배포할지는 사용자에게 묻습니다.
3. 드라이런으로 빌드합니다. 빌드는 임시 폴더에 합니다.

   ```bash
   PYIDE_DIST_DIR="$LOCALAPPDATA\\Temp\\pyidedist-0.3.14" npm run release -- 0.3.14 --dry-run
   ```

4. 만든 `win-unpacked`의 exe를 띄워 Code와 Craft가 열리는지 직접 확인합니다.
5. 실제 릴리스를 합니다. `--skip-tests`는 CI가 통과했을 때만 씁니다. 스크립트가 버전 올리기, 빌드, 커밋과 태그, 푸시, 업로드, `latest.yml` 확인까지 합니다.
6. 새 설치 파일(`NanoStudio-Setup-<v>.exe`, 그 `.blockmap`, `NanoStudio-<v>.msi`, `latest.yml`)을 `dist/`로 복사합니다. `dist/`의 옛 버전은 지우지 않습니다. 그 뒤 임시 폴더를 지웁니다.
7. `gh release list -R mandur23/Portfolio-Nano-`에서 Latest가 여전히 v1.4.3인지 봅니다. `nano-studio` 릴리스가 Latest가 되면 안 됩니다.

옵션: `--dry-run`(명령만 출력), `--skip-tests`(설치본 테스트 건너뛰기), `--publish-only`(푸시 뒤 멈춘 릴리스의 업로드만), `--no-build`(드라이런 시험용: 빌드를 건너뛰고 `dist`에 있는 것을 확인). 서명 키는 `%USERPROFILE%\.nano-studio\release-key.pem`에 있고 저장소에 넣지 않습니다. `marketplace/index.json`을 바꾸면 같은 커밋에서 `npm run marketplace:sign`을 실행합니다.

## 9. 하지 않는 것

- 요청 없이 커밋, 푸시, 릴리스하지 않습니다.
- 시스템 소프트웨어를 설치하거나 사용자 대신 로그인하지 않습니다.
- `dist/`의 옛 설치 파일을 지우지 않습니다.
- Craft의 금지 사항(EULA 동의, 실제 런처와 게임 실행 등)은 [craft-app.md](craft-app.md)의 "하지 않는 것"에 있습니다.
