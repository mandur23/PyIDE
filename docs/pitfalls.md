# 코딩과 테스트 때 참고할 문제 기록

지금까지 실제로 겪은 문제와 그 규칙을 모았습니다. 새 문제를 고치면 원인과 규칙을 여기에 한 줄 추가합니다. 기능 설명은 `FEATURES.md`, 배포 내역은 `CHANGELOG.md`에 있습니다.

## 코딩: 보안

- **프로그램 이름만으로 실행하면 프로젝트 안의 가짜 exe가 실행될 수 있습니다.** Windows는 현재 폴더와 `cwd`에서 먼저 찾습니다. 안전 모드에서 심어 둔 `git.exe`, `python.exe`가 클릭 없이 실행됐습니다.
  - `main.js` 맨 위에서 `NoDefaultCurrentDirectoryInExePath=1`을 켜고 작업 폴더를 userData로 옮깁니다. 이 코드를 옮기거나 지우지 않습니다.
  - 사용자 터미널과 Run/Debug 자식 프로세스는 `main/program-env.js`로 이 변수를 뺀 환경을 씁니다.
  - 명령줄의 상대 경로는 `launchDir` 기준으로 풉니다. `process.cwd()`가 아닙니다.
  - `cmd.exe`로 도구를 실행하면 `.\` 경로를 씁니다. `toolchains.js:70`의 `mvn`은 아직 변수 없이 `cmd.exe`로 실행됩니다.
- **프로젝트의 파일이나 설정을 실행·해석하는 IPC는 신뢰 여부부터 확인합니다.** `trust.isTrusted(root)` 또는 `guard()`를 씁니다. `workspace:info`, `frameworks:*`, `semantic:index`, `workspace:start`가 빠져 있었습니다. Git도 위험합니다. `.git/config`의 `core.fsmonitor`가 `ls-files` 등에서 프로그램을 실행합니다.
- **사용자나 파일에서 온 문자열을 git 인자로 넘길 때는 `--`를 넣거나 `-` 시작을 막습니다.** `--upload-pack=<명령>`이 clone 주소로 실행됐습니다.
- **받은 모드와 플러그인은 코드입니다.** 받은 주소 제한만으로는 부족합니다. 팩 안의 `overrides/mods/*.jar`는 주소 제한을 받지 않습니다. 실행 전에 사용자 승인을 받고, 내용이 바뀌면 다시 묻습니다. 플러그인은 디스크 설치도 경고합니다.
- **대역 서버는 정확한 origin으로만 허용합니다.** `PYIDE_MC_SOURCES`의 `standIn()`이 기준입니다. 넓은 우회를 만들지 않습니다.
- **네트워크 경로(`\\host\...`)를 메인에서 건드리면 NTLM 자격 증명이 나갑니다.** 경로를 받으면 `ide.mayFollowPath`와 `allowShare`를 지납니다.
- **숨김 파일 확인은 실제 경로에서 다시 합니다.** `.env`는 8.3 이름 `ENV~1`로, `:` 는 NTFS 스트림으로 우회됩니다. `realpath` 뒤에 검사하고 그 실제 파일만 읽습니다.
- **Windows에서 경로 이름만 보고 판단하지 않습니다.** 끝의 점(`app.exe.`), 8.3 이름, junction을 고려합니다.
- **zip을 믿지 않습니다.** 저장(stored) 항목은 `data.length === e.size`를 확인하고, 항목 수를 제한하고, 겹치는 항목을 거부합니다.
- **DB에는 평문 폴백을 넣지 않습니다.** TLS가 없는 서버는 SSL 모드를 안내하는 오류로 끝납니다.
- **업데이트는 서명 확인 없이 설치하지 않습니다.** `phase: 'downloaded'`가 설치의 유일한 관문입니다. `latest.yml`은 서명되지 않으니 그 안의 값을 믿지 않습니다.
- **서명 없는 외부 exe는 백신이 지울 수 있습니다.** bore.exe는 공식 릴리스를 해시로 고정해 받았는데도 Defender가 `Trojan:Win32/Kepavll!rfn`으로 격리했습니다. 사용자에게 예외 등록을 시키지 않습니다. 작은 프로토콜은 앱 안에서 처리합니다(`main/bore-client.js`). 탐지 원인은 `Get-MpThreatDetection`과 Defender 이벤트 1116/1117에서 읽습니다.
- **비밀값은 로그와 진단 보고서에 남지 않게 합니다.** 새 형식의 비밀값을 다루면 `main/diagnostics/redact.js`와 `verify/redact.mjs`에 추가합니다.
- **`data get`의 답은 여러 줄일 수 있고 그 줄은 플레이어가 씁니다.** 1.20.1은 문자열의 줄바꿈을 그대로 찍고(26.3은 이스케이프합니다) `\`와 여는 따옴표만 이스케이프해서, 책 한 쪽이 서버 로그 줄을 그대로 흉내 냈습니다. 서버 정지, 가짜 채팅, 가짜 `/op`가 기록에 들어갔습니다. 답은 끝날 때까지 줄이 아니라 답입니다(`snbtEnd`). 상한을 넘어도 그 뒤를 줄로 되돌리지 않습니다. 위조가 노리는 곳이 상한 뒤입니다.
- **서버 답은 "다음 줄"이 아니라 모양으로 고릅니다.** 명령 뒤 첫 줄을 답으로 받았더니 다른 사람의 접속 실패 줄이 답이 되어 IP가 `admin.jsonl`에 남고 성공 여부도 틀렸습니다. 모양은 `actions.js`의 표에 있고 문구는 실제 `en_us.json`에서 확인합니다. 1.20.1과 26.3의 문구가 다릅니다(`commands.op.failed`, `command.unknown.command`).
- **개인정보 규칙은 저장 경로마다 막지 않고 한 곳에서 지킵니다.** 저장되는 줄은 모두 `store.js`의 `lineOf`를 지나고 거기서 주소를 가립니다. 길이 제한으로 자르기 전에 가립니다. 자른 뒤에는 주소 모양이 아니게 되어 세 자리가 남습니다.

## 코딩: Electron과 Node

- **`fs.cpSync`는 Electron 38에서 한글 경로면 프로세스가 강제 종료됐습니다.** 복구할 수 없는 네이티브 종료라 try/catch로 못 막습니다. 0.3.0에 배포됐습니다. 지금은 Electron 45라 재현되지 않지만 복사는 기존 헬퍼(`copyMissing`, `copyTree`)를 씁니다.
- **Electron 45는 `npm install`만으로 실행 파일을 받지 않습니다.** 패키지에 postinstall이 없어서 `electron.exe`가 없는 채로 끝나고, CI 앞쪽 테스트가 `spawn ... electron.exe ENOENT`로 실패했습니다. 우리 `package.json`의 `postinstall`이 `install-electron`을 실행합니다. Electron을 올릴 때 이 동작이 그대로인지 확인합니다.
- **Electron 45의 `clipboard`는 `read`, `write`, `readText`, `writeText`, `has`, `clear`만 있고 `readText`는 비동기입니다.** `ipcMain.handle`은 await하므로 괜찮지만 동기로 쓰면 안 됩니다.
- **`safeStorage`의 동기 API는 Electron 45에서 deprecated입니다.** 아직 동작합니다. 12곳(`clipboard-history`, `database`, `installer`, `askpass`)이 씁니다.
- **IPC 오류는 메시지만 넘어오고 `.code`는 사라집니다.** 화면이 분기해야 하는 조건은 throw가 아니라 결과 값으로 돌려줍니다(`{launched: false, code: 'noLauncher'}`).
- **배열에 덧붙인 속성은 contextBridge를 건너지 못합니다.** `players:items`의 `reason`과 `coverage`가 렌더러에서 사라졌습니다. `v8.serialize`로는 살아남아서 Node 테스트는 통과했습니다. 목록과 함께 보낼 값은 `{items, reason}`처럼 객체에 담고, IPC 값은 실제 창에서 확인합니다.
- **창 캡처 권한은 Electron 45에서 다시 확인이 필요했습니다.** 업그레이드 후 게임 캡처가 검은 화면이 됐습니다.
- **스크립트 로드 순서에 기대지 않습니다.** Monaco 콜백이 `editors.js`보다 먼저 끝나 `ide.initEditors is not a function`이 났습니다. 지금은 `DOMContentLoaded`를 기다립니다.
- **외부 라이브러리는 정적으로 먼저 로드합니다.** `marked`를 지연 로드하다 `window.marked`가 비어 AI Chat 창이 무한 루프로 멈췄습니다. 이미 끝난 Promise를 기다리는 반복문은 창을 멈춥니다.

## 코딩: 렌더러

- **CSP가 있습니다(`renderer/index.html`).** 인라인 스크립트와 인라인 이벤트 핸들러, `eval`을 쓸 수 없습니다. 렌더러 코드는 네트워크에 직접 접속할 수 없고 메인 모듈을 거칩니다(`connect-src data:`). `srcdoc` 프레임은 IDE의 CSP를 물려받습니다.
- **`innerHTML`에 외부 값을 넣지 않습니다.** 서버 이름, 참여 코드, 팩 이름은 `textContent`로 넣습니다. Markdown은 허용 목록 방식 sanitizer를 지납니다.
- **입력칸이 있는 영역을 통째로 다시 그리지 않습니다.** `replaceChildren()`이 입력한 글자와 오류 표시를 지웠습니다. 폼은 마운트 때 한 번 만들고 목록만 다시 그립니다. 비동기 작업 뒤에 캡처해 둔 노드에 쓰면 화면에 안 보입니다.
- **접히는 목록을 흐름 안에 두면 누르는 사이 버튼이 움직여 클릭이 사라집니다.** 목록은 흐름 밖에 두고, 테스트는 `Input.dispatchMouseEvent`로 실제로 눌렀다 뗍니다. 합성 클릭은 이 문제를 못 찾습니다.
- **크기는 반올림 값으로 계산해 되먹이지 않습니다.** Data View가 `clientWidth`/`clientHeight` 때문에 스크롤바가 매 프레임 뒤집혀 로딩이 끝나지 않았습니다. 퍼센트 CSS를 씁니다.
- **좁은 창에서는 뷰포트가 아니라 컨테이너를 봅니다.** 탭은 `@container`로 배치를 바꿉니다.
- **넘치지 않는 것과 보이는 것은 다릅니다.** Players 탭을 900 px 창에서 Run 패널과 함께 열면 목록과 머리글이 높이를 다 써서 플레이어가 화면에 없었는데, overflow 검사는 통과했습니다. 낮은 창에서는 고정 영역을 나누지 말고 한 스크롤로 둡니다. 테스트는 `elementFromPoint`로 실제로 보이는지 확인하고 스크린샷을 직접 봅니다.
- **큰 파일의 언어 기능을 확인합니다.** Monaco CSS lint가 선언 쌍마다 마커를 만들어 큰 파일에서 렌더러가 메모리 초과로 죽었습니다.
- **글자 폭에 딱 맞는 배치는 다른 PC에서 잘립니다.** 한글은 PC의 글꼴로 대체되고, CI 러너에서는 900 px 카드의 버튼 글자가 합쳐서 약 8 px 넓어 1 px 모자란 버튼이 전부 말줄임이 됐습니다. 고정 폭 줄에는 여유를 둡니다.
- **비동기 답을 기다리는 동안 문서가 닫힐 수 있습니다.** Monaco의 CSS, HTML, JSON 완성은 워커 답을 받은 뒤 모델을 읽어 `TextModelPart is disposed!`를 던졌습니다. 느린 PC에서만 보입니다. `ide.js`가 완성 제공자를 감쌉니다.
- **Pyright는 준비됐다고 말한 뒤에도 아직 목록에 넣지 않은 닫힌 파일의 `documentSymbol`에 `[]`를 답합니다.** 그 답을 캐시하면 표시가 영구히 빠집니다(형식 계층 여백 표시). 빈 답으로 만든 결과는 보관하지 않고 다시 묻습니다.

## 코딩: Code와 Craft 모드

- **플러그인 `modes`의 기본값은 `['code']`입니다.** 필수 플러그인만 모든 모드에서 로드됩니다. `bundled`가 아닌 플러그인의 `required`는 무시합니다.
- **Craft에는 편집기 영역, 툴바, 스트라이프가 없습니다.** 편집기 탭으로 여는 화면은 `body.mc-craft-tab`으로만 보입니다. 설정 페이지는 `craft: true`인 것만 나옵니다.
- **Craft에는 `ide.debugger`가 없습니다.** code 전용 플러그인의 API는 `?.`로 부릅니다.
- **`ide.openProject`, `ide.closeProject`는 Craft에서 거부됩니다.**
- **서버 JVM의 인코딩은 `launch()`가 정합니다.** 메인은 출력을 UTF-8로 읽고 stdin도 UTF-8로 쓰는데, 한국어 Windows의 JVM은 파이프에 MS949를 씁니다(Java 21, 25에서 확인). 한글 채팅이 깨진 채 30일 저장됐습니다. `desc.jvmArgs`가 기본 옵션을 대체하므로 플래그는 그 밖에 두고, `verify/minecraft.mjs`가 `-Xmx`와 GC 옵션의 순서를 고정해서 맨 앞에 둡니다. stdin은 바닐라가 UTF-8로 고정이고 Paper는 기본 문자셋을 쓰므로 `file.encoding`이 맞춥니다. `stdin.encoding`만으로는 부족합니다.
- **26.3은 콘솔에 보내는 말을 `System chat: ` 뒤에 찍습니다.** `MinecraftServer.sendSystemMessage`가 로그 형식을 바꿨고, 서버 자신이 콘솔의 `CommandSource`라서 명령의 답과 방송(접속, 사망, 업적)이 전부 이 형식입니다. 1.20.1에는 없고 채팅은 로거가 달라서 없습니다. 위키에도 대역에도 없어서 `javap`로 클래스를 읽고서야 찾았습니다. 줄 형식의 가정은 실제 클래스에서 확인합니다.
- **언어 파일의 키가 전부 게임의 id는 아닙니다.** 26.3의 `en_us.json`에는 이름이 바뀐 뒤의 `enchantment.minecraft.sweeping`이 `sweeping_edge` 옆에 남아 있어 같은 이름이 두 줄 나왔습니다. 대역 jar로는 안 보이고 실제 jar에서만 보입니다.

## 코딩: 번역

- **한국어 사전은 모드별로 합쳐집니다.** Code 전용 플러그인 사전에만 있는 문구는 Craft에서 영어로 나옵니다. `Loading…`, `Type:`, `Port:`처럼 공용 문구는 `renderer/locales/ko.json`에 넣습니다.
- **같은 키는 나중에 로드된 플러그인이 이깁니다.** `Play`가 뷰어의 "재생"과 겹쳐 Craft는 `Play Minecraft`, `Launch`를 씁니다.
- **이름 뒤 조사를 쓰지 않습니다.** `{name}을(를)`이 어색합니다. `'{name}' 서버를 추가했어요`처럼 조사가 이름에 붙지 않게 씁니다.
- **Craft 문구는 -요 말투입니다.** 메인의 영어 로그를 그대로 풍선에 보이지 않습니다. 원문은 Run 탭에 두고 화면에는 한국어 단계를 보여 줍니다.

## 테스트

- **이 작업 환경에는 `NoDefaultCurrentDirectoryInExePath=1`이 이미 켜져 있습니다.** 그래서 가짜 exe 문제가 테스트에서 드러나지 않았습니다. 관련 테스트는 앱 쪽 환경에서 이 변수를 빼야 합니다(`verify/safe-mode.mjs`). 테스트 프로세스 자체는 켠 채로 둡니다. 안 그러면 준비 단계의 `git`이 가짜 exe를 실행합니다.
- **테스트 코드도 고치기 전 코드로 돌려서 실패하는지 봅니다.** 심어 둔 프로그램은 실행 흔적을 남겨야 합니다. `whoami` 복사본은 흔적이 없어 테스트가 실패할 수 없습니다.
- **사용자가 쓰는 PC에서는 숨겨진 데스크톱에서 돌립니다.**

  ```bash
  powershell -NoProfile -ExecutionPolicy Bypass -File verify/on-desktop.ps1 -Out verify/out/run.txt node verify/core.mjs
  ```

  `-Out`은 저장소 기준 상대 경로만 됩니다. 절대 경로면 스크립트가 바로 실패하고 테스트 213개가 1초 만에 전부 실패한 것처럼 보입니다.
- **결과가 비정상적으로 빠르면 먼저 실행 자체를 의심합니다.** 통과 수가 비어 있으면 테스트가 돌지 않은 것입니다.
- **CDP 포트가 테스트마다 고정입니다.** 같은 테스트를 동시에 돌리면 서로의 창을 잡습니다. 실패 스크린샷에 다른 창이 보이면 혼자 다시 돌립니다.
- **병렬 실행의 실패는 혼자 다시 돌려 확인합니다.** 3개씩 돌리면 시간 초과가 나옵니다. 혼자서도 실패할 때만 진짜 문제로 봅니다. 성능 테스트는 병렬에서 믿지 않습니다.
- **새로고침은 `ctx.reload()`를 씁니다.** `Page.reload` 응답이 먼저 와서 예전 페이지가 준비됐다고 답하고, 다음 호출에서 `ide is not defined`가 납니다.
- **`Inspector.detached`는 렌더러가 죽은 것입니다.** 죽은 렌더러의 소켓은 열려 있어 호출이 영원히 기다립니다. 이제 `lib.mjs`가 오류로 처리합니다. 테스트가 15분 시간 초과면 렌더러 충돌을 먼저 의심합니다.
- **CSP 위반이 있으면 `finish()`가 테스트를 실패시킵니다.** Markdown의 `on*` 속성은 sanitizer의 파싱 때도 보고됩니다. 이 경우만 `SANITIZED_HANDLER`로 걸러집니다.
- **실제 OS 드래그는 마우스 메시지가 있어야 끝납니다.** `verify/post-mouse-move.ps1`로 테스트 창에만 메시지를 보냅니다. 실제 마우스를 움직이지 않습니다.
- **테스트는 클립보드를 보존해야 합니다.** Electron 45에서 `clipboard-keeper`가 조용히 고장 나 있었습니다. 로그에 경고가 있는지 봅니다.
- **`verify/out`은 여럿이 같이 씁니다.** 다른 세션의 정리가 실행 중인 폴더를 지울 수 있습니다. 동시 작업 중에는 `node verify/clean.mjs --age 15`를 쓰고, 끝난 뒤 `--age 0`을 씁니다. `*-venv`와 `downloads-cache`는 남깁니다.
- **Craft 창을 띄우는 테스트는 `PYIDE_CRAFT_HOME`을 줍니다.** 없으면 `projectDir`와 상관없이 사용자의 `~/Nano Studio Craft`가 열립니다. 테스트 창에 사용자의 실제 서버가 나타났습니다. 시작 뒤 `ide.root`가 테스트 폴더인지 확인합니다.
- **문구 검사는 Code와 Craft 양쪽을 봅니다.** `verify/i18n-static.mjs`가 모드별로 검사합니다. 예전에는 전부 합쳐 검사해서 Craft 누락을 못 찾았습니다.
- **로그 형식은 실제 파일로 확인합니다.** 대역은 우리가 쓴 형식만 재현합니다. 26.3의 `System chat: ` 접두사는 Gradle 캐시의 실제 jar를 읽고서야 찾았고, 그 뒤 실제 Paper 26.3에서 확인했습니다.
- **대역으로 검증한 것과 실제로 검증한 것을 구분해서 보고합니다.** 공식 Minecraft Launcher와 게임은 테스트에서 실행하지 않습니다. EULA에 동의하지 않습니다. 로그인하지 않습니다.
- **게임 파일은 실행하지 않아도 읽을 수 있습니다.** 이 PC의 Gradle 캐시에 실제 jar가 있습니다(`~/.gradle/caches/fabric-loom/26.3`, `forge_gradle/.../1.20.1`). `en_us.json`을 읽고 `javap`로 클래스를 읽으면 기억이나 위키로 추측하던 것을 확인할 수 있습니다. 문구, 이스케이프 규칙, 콘솔의 문자셋, NBT 깊이가 그렇게 확인됐습니다. 실행은 하지 않습니다.
- **전체 대조 검사의 기대값에 쓴 문구도 대역이 지어낸 것일 수 있습니다.** 서버 답 모양을 좁히면 `verify/minecraft-players.mjs` 대역의 문구도 실제 문구와 같은지 봅니다.
- **CI는 느린 1024x720 러너입니다.** 릴리스마다 다른 단계가 실패합니다. 클릭과 타이밍 문제가 많습니다. 로컬에서 통과해도 CI 결과를 확인합니다.
- **러너와 비슷하게 돌리려면 `PYIDE_TEST_VIEWPORT=1024x720 PYIDE_TEST_CPU=2`를 줍니다.** `verify/lib.mjs`가 창 크기와 렌더러 CPU를 에뮬레이션합니다. 프로세스 CPU를 2개로 묶고 `PYIDE_TEST_CPU=4`를 주면 러너보다 훨씬 느려져 러너에서 안 나는 실패가 나옵니다. 러너의 Prettier 대역은 0.3초, 이 조건에서는 8초가 걸렸습니다. 화면 에뮬레이션은 `screen.avail*`을 실제 작업 영역과 다르게 만드니 `minecraft`는 이 변수 없이 돌립니다. 숨겨진 데스크톱에서는 `minecraft`의 F3+T와 Inside the IDE 검사 3개가 실패합니다. 러너에서는 통과합니다.
- **러너의 `%TEMP%`는 8.3 이름입니다(`C:\Users\RUNNER~1`).** Java의 `getCanonicalPath`, `where`, venv는 긴 이름을 돌려줘서 경로를 문자열로 비교하면 틀립니다. 서버가 0개 실행 중으로 보이고 "서버 없음"을 확인하는 검사는 거짓으로 통과했습니다. `realpathSync.native`로 맞춥니다. 8.3 이름이 꺼진 드라이브에서는 `%TEMP%` 안의 junction을 `TEMP`, `TMP`로 주고 Java 쪽을 `toRealPath()`로 바꾸면 재현됩니다.
- **러너에는 `CI=true`가 있습니다.** pytest는 이 변수가 있으면 실패한 `==`를 전부 포맷하고 ndiff합니다. 100만 개 리스트 다섯 번이 0.2초에서 19초(로컬), 120초 초과(러너)가 됐습니다. 사용자의 pytest를 재는 테스트는 `CI`와 `BUILD_NUMBER`를 뺍니다.
- **크기 기대값은 앱과 같은 식으로 계산합니다.** Beside 배치는 작업 영역의 40%지만 최소 480 px입니다. 1024 px 화면에서는 최소값이 이깁니다.
- **`dataview`, `diagnostics`의 오래된 실패는 원인이 있었습니다.** "원래 실패하던 테스트"로 넘기지 말고 원인을 찾습니다. 앞서 넘긴 두 건 모두 진짜 앱 버그였습니다.

## 도구 사용

- **Bash heredoc과 `sed` 치환은 역슬래시를 먹습니다.** Windows 경로와 `\u`가 깨진 일이 여러 번 있었습니다. 파일 수정은 Edit/Write 도구를 쓰고, 스크립트는 파일로 만들어 실행합니다.
- **`node -e` 안의 백틱은 Bash가 실행합니다.** 템플릿 문자열이 든 코드는 `node -e`로 쓰지 않습니다.
- **`String.replace`에는 함수를 넘깁니다.** 치환 문자열의 `$`가 해석됩니다.
- **파일은 LF입니다.** CRLF 파일을 고치면 전체 diff가 납니다.
- **시스템 전체를 바꾸지 않습니다.** subst 드라이브, 전역 환경 변수, 레지스트리, 프로토콜 핸들러를 건드리지 않습니다.

## 릴리스

- **`npm run release -- <버전>`은 package.json보다 높은 버전만 받습니다.** 미리 버전을 올리지 않습니다. `CHANGELOG.md`에 그 버전 절이 있어야 합니다.
- **`nano-studio` 릴리스는 Latest가 되면 안 됩니다.** Melody Breeze APK 링크가 `releases/latest`를 씁니다.
- **서명 비밀키는 `%USERPROFILE%\.nano-studio\release-key.pem`에 있습니다.** 저장소에 넣지 않습니다. 잃어버리면 설치된 앱에 업데이트를 보낼 수 없으니 안전한 곳에 백업합니다. 공개키는 `main/release-key.js`에 있습니다. 키가 바뀌면 기존 설치본은 새 업데이트를 거부합니다.
- **`marketplace/index.json`을 바꾸면 같은 커밋에서 `npm run marketplace:sign`을 실행합니다.** 안 하면 release 1단계가 멈춥니다.
- **포트폴리오 사이트는 고정 이름 `NanoStudio-Setup.exe`를 가리킵니다.** 저장소 이름은 `mandur23/PyIDE` 그대로입니다.
- **설치본 테스트(`verify/installed.mjs`, `update-e2e`, `update-delta`)는 평소 건너뜁니다.** 패키징 영향이 큰 변경(Electron, 경로, CSP)은 빌드한 앱을 직접 띄워 확인합니다.

## 아직 남은 문제

- 디버그: Run/Debug의 debugpy `--listen`과 JDWP는 다른 로컬 계정이 먼저 접속할 수 있습니다. debugpy 1.8.22의 토큰 방식은 맞지 않습니다.
- 업데이트: `latest.yml`이 서명되지 않아 쓰기 권한자가 옛 서명 설치 파일을 재전송할 수 있습니다. MSI 설치본은 앱이 서명을 확인하지 않습니다. 매핑된 네트워크 드라이브는 로컬 폴더로 보입니다.
- 인증서: Authenticode 서명이 없어 SmartScreen 경고가 납니다.
- DB: Redis, Mongo, ClickHouse의 TLS는 기본 꺼짐입니다. Oracle은 SSL 항목이 없습니다. 검증 모드에 CA 파일을 지정할 수 없습니다.
- 안전 모드: 신뢰한 프로젝트의 HTML 미리보기는 이미지, 이동, WebRTC로 데이터를 내보낼 수 있습니다. `toolchains.js:70`의 `mvn`은 프로젝트의 `mvn.cmd`를 실행할 수 있습니다.
- `safeStorage` 비동기 API로 옮기지 않았습니다.
- `shell.openPath`가 없는 파일에서 25초 넘게 돌아오지 않았습니다. 원인을 모릅니다.
- dompurify: Monaco 0.57.0이 3.4.15를 묶고 있어 npm audit에 critical로 남습니다. Monaco 번들은 해당 모드를 쓰지 않는 것으로 보입니다(코드 확인, 시험은 안 함).
- 공식 Minecraft Launcher와 실제 게임으로는 한 번도 시험하지 않았습니다.
- `main/bore-client.js`는 실제 bore.pub에서 주소를 받는 것까지 확인했고, 외부에서 그 주소로 접속하는 것은 `verify/port-sharing-bore-live.mjs`를 사용자가 승인해야 확인할 수 있습니다.
- 첫 시작 PyIDE 가져오기 알림은 일부가 실패해도 모두 복사했다고 말합니다. 실패한 항목은 다음 시작 때 다시 시도합니다.
