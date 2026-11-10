# Nano Studio Craft 개발 가이드

Nano Studio Craft(마인크래프트 앱)를 고칠 때 보는 문서입니다. 공통 구조와 작업 순서는 [development.md](development.md), 이 앱에서 겪은 문제는 [pitfalls.md](pitfalls.md)의 "공통"과 "Craft" 절에 있습니다. 기능별 상세 명세는 [FEATURES.md](../FEATURES.md)의 "Minecraft servers"와 그 아래 절에 있습니다.

설계 문서:

- [nano-studio-design.md](nano-studio-design.md): Code와 Craft 분리, 런처, Craft 화면의 처음 설계
- [craft-players-design.md](craft-players-design.md): 플레이어 탭
- [craft-private-share-design.md](craft-private-share-design.md): 비공개 공유의 위협 모델과 프로토콜

## 1. 실행

```bash
npm start -- --mode=craft
```

- 작업 폴더는 `%USERPROFILE%\Nano Studio Craft`입니다. 앱이 만들고, 신뢰하고, 프로젝트로 엽니다. `servers/`(내 서버), `instances/`(플레이용 인스턴스), `.launcher/`(공식 런처의 작업 폴더), `servers-list.json`(참여할 서버)이 여기에 있습니다.
- 테스트와 실험은 `PYIDE_CRAFT_HOME`으로 다른 폴더를 줍니다. 안 주면 사용자의 실제 서버가 열립니다.
- Craft에서 로드되는 플러그인은 필수 플러그인(diagnostics, notifications, problems, project-roots, run, settings, terminal)과 minecraft, port-sharing, installer, updater입니다. 나머지 Code 플러그인은 없습니다.

## 2. 화면 구조

- `body.app-craft`가 켜지고 CSS가 IDE의 툴바, 스트라이프, 프로젝트 패널, 편집기 영역을 숨깁니다. `#craftHost`가 창을 채우고, 아래에 Run 툴 윈도우가 접혀 있습니다.
- 작업 폴더가 열리면 `ide.emit('craftReady', {host})`가 오고, minecraft 플러그인이 화면을 붙입니다.
- 왼쪽 목록: 플레이, 서버 참여, 내 서버, Market. 그 아래 새 인스턴스, 새 서버, 모드팩으로 서버 만들기, 설정, 정보.
- 편집기 탭(서버 설정, 플레이어 탭, 파일)을 열면 `body.mc-craft-tab`이 켜져 탭이 앱 전체를 덮습니다. 탭 안의 버튼이 탭 밖 화면으로 보내면 탭을 먼저 닫습니다.
- 설정 창에는 `craft: true`인 페이지만 나옵니다. `ide.debugger` 같은 Code 전용 API는 없습니다. `ide.openProject`와 `ide.closeProject`는 거부됩니다.
- 문구는 모두 한국어 -요 말투입니다. 메인의 영어 로그는 Run 탭에 두고 화면에는 한국어 단계를 보여 줍니다.

## 3. 파일 지도

### 렌더러 (`renderer/features/minecraft/`, `"modes": ["craft"]`)

| 파일 | 맡은 일 |
| --- | --- |
| `index.js` | 내 서버 카드(시작, 정지, 공유, Market, 클라이언트 팩, 리소스 팩, 플레이어, 설정, 폴더), 새 서버 대화상자, 드롭 받기 |
| `screen.js` | `#craftHost`의 전체 화면과 왼쪽 목록 |
| `craft.js` | 플레이(인스턴스 카드, 모드 목록, 모드 한국어 번역, 새 인스턴스)와 서버 참여(참여 코드, 주소, 참여) |
| `market.js` | Modrinth를 상점처럼 보여 주는 Market |
| `server-settings.js` | 서버 설정 탭(섹션, 검색, 화이트리스트, op, 안티 엑스레이, 모드 번역) |
| `backups.js` | 백업 탭(목록, 지금 백업, 되돌리기, 일정과 보관), 위험한 동작 전 자동 백업(`mc.backups.before`) |
| `players.js`, `players-drag.js`, `players-bridge.js` | 플레이어 탭, 인벤토리 끌기, 상세 기록(NanoBridge) 설치 |
| `health.js` | 카드의 비정상 종료·응답 없음·과부하 표시, 자동 재시작, 설정 탭의 "비정상 종료와 과부하" |
| `style.css`, `locales/ko.json` | 모양과 한국어 |

### 메인

| 파일 | 맡은 일 |
| --- | --- |
| `main/features/minecraft.js` | `minecraft:*` IPC 등록, 서버 만들기와 실행 |
| `main/minecraft/sources.js` | Paper, Purpur, Vanilla, Fabric, Forge, NeoForge, Velocity의 버전과 다운로드 주소. `base()`로 테스트 대역 주소를 받습니다 |
| `main/minecraft/launcher.js` | 인스턴스, 로더 설치, 공식 런처 프로필과 실행, 참여 코드, 팩 동기화, 인스턴스 모드 번역과 `options.txt` |
| `main/minecraft/hosts.js` | 이름이 이 컴퓨터나 내 네트워크로 풀리는지(참여 코드 주소, 팩 주소) |
| `main/minecraft/market.js` | Modrinth 검색과 설치, 업데이트, 제거 |
| `main/minecraft/imports.js` | 드롭한 파일과 폴더, 모드팩(.mrpack) 가져오기 |
| `main/minecraft/server-settings.js` | `server.properties`, 화이트리스트, op 읽기와 쓰기(`readProperties`, `writeProperties`) |
| `main/minecraft/anti-xray.js` | Paper 안티 엑스레이 설정 파일 고치기 |
| `main/minecraft/translate.js` | 모드 문구 한국어 번역(Claude Code CLI). 서버의 `resourcepack/`과 인스턴스의 `resourcepacks/Nano Studio Korean/`에 씁니다 |
| `main/minecraft/templates.js` | 리소스 팩 `pack.mcmeta`, Velocity 연결 |
| `main/minecraft/file-server.js` | 클라이언트 팩과 리소스 팩을 루프백 http로 제공 |
| `main/minecraft/health.js`, `health-monitor.js` | 비정상 종료의 원인, 자동 재시작 규칙, 멈춤과 과부하 감지 |
| `main/minecraft/ping.js`, `serversdat.js` | 서버 목록 핑, 게임의 `servers.dat` |
| `main/minecraft/zipfile.js` | zip 쓰기와 jar 안 파일 읽기 |
| `main/minecraft/zip64.js` | 크기 제한 없는 zip 쓰기와 읽기(스트림, ZIP64). 백업과 `writeZipFile`, `openZip`이 씁니다 |
| `main/minecraft/backups.js` | 월드 백업과 되돌리기, 보관 규칙, 일정. 다른 메인 코드는 `require('../features/minecraft').backups`의 API를 씁니다(파일 머리 주석) |
| `main/minecraft/private-join.js` | 친구 쪽 비공개 참여 프로세스 |
| `main/minecraft/players/` | 플레이어 세션, 로그 해석, 기록 저장, 동작 명령, NBT, 아이템, NanoBridge |
| `main/bore-gate.js`, `main/bore-client.js` | 비공개 공유 터널의 프로토콜과 bore 클라이언트 |
| `main/features/port-sharing.js` | 포트 공유(bore, Cloudflare) |
| `tools/nano-bridge/` | NanoBridge 플러그인 소스. `main/minecraft/players/NanoBridge.jar`로 빌드합니다 |

## 4. 기능별 핵심 규칙

### 서버

- 서버마다 `servers/<이름>/pyide-server.json`이 종류, 버전, 로더, Java, 실행 방법을 적습니다.
- 새 서버는 사용자가 EULA에 동의해야 만듭니다. 다운로드는 체크섬을 확인하고, 실패하면 반쯤 만든 서버를 지웁니다. 만드는 중에는 `pyide-server.unfinished` 표시를 둡니다.
- 실행은 `launch()`가 정한 JVM 옵션으로 합니다. 출력과 stdin의 인코딩을 UTF-8로 고정합니다(한국어 Windows의 JVM은 MS949를 씁니다).
- 정지는 `stop`을 보내고, 그 뒤 60초 동안 아무것도 출력하지 않으면 죽이고 콘솔과 알림으로 알립니다. 계속 출력하면 15분까지 기다립니다. stdin에 `stop`이 간 순간부터 서버는 "멈추는 중"입니다(`health-monitor.js`의 `markStops`가 `proc.stopAsked`와 `'stopAsked'` 이벤트로 알립니다). 멈추는 동안에는 정지 로직만 stdin에 쓰고 서버를 끝냅니다: 백업(예약 백업 포함)은 시작하지 않고, 하던 백업은 바로 버리며 `save-on`도 보내지 않습니다(정지가 어차피 저장합니다). 건강 감시는 `tps`와 ping을 멈추고 멈춤 판정을 하지 않으며, 플레이어 세션은 질의를 그칩니다. 강제로 끝낸 정지는 정지이지 비정상 종료가 아니므로 자동 재시작도 하지 않습니다. 앱 종료 때는 main.js의 quit gate가 저장을 기다립니다(서버마다 60초). Windows 종료와 로그오프에는 before-quit이 없으므로, 서버가 실행 중이면 창의 `query-session-end`에서 세션 종료를 붙잡고 quit gate의 일을 먼저 한 뒤 앱을 끝냅니다.
- 실행 중인 서버 폴더에는 `pyide-server.running`(pid, 시작 시각, 폴더)이 있습니다. 앱이 죽어도 서버는 남으므로, 다음 시작은 이 표시의 pid가 그 시각에 시작한 java.exe인지 보고 맞으면 시작을 거절하고 카드에 "서버 끝내기"를 보입니다. 끝내기는 저장 없는 강제 종료라 먼저 묻습니다.
- 서버의 비정상 종료, 멈춤, 과부하는 `main/minecraft/health.js`(증거 읽기, 원인 분류, 재시작 규칙, 멈춤과 과부하 판단. 시계를 넣을 수 있는 순수 함수)와 `health-monitor.js`(프로세스 연결, `minecraft:health` 이벤트), 렌더러의 `health.js`(카드, 알림, 설정 탭의 "비정상 종료와 과부하")가 맡습니다.
  - 예상한 종료는 stdin에 간 `stop`/`end`(정지, 재실행, 재시작, quit gate, 업데이트, Windows 세션 종료가 모두 이 길로 갑니다), 앱 종료 중, 서버가 남긴 `Stopping the server`(관리자의 /stop)입니다. 그 밖의 종료는 종료 코드와 상관없이 비정상 종료입니다. 다음 앱 시작 때 프로세스가 없는 실행 표시도 "앱이 보지 않는 동안 끝남"으로 알립니다.
  - 원인은 증거로만 말합니다: 콘솔 끝, 이번 실행의 `logs/latest.log`, `crash-reports/*.txt`, `hs_err_pid<pid>.log`. 아는 원인이 없으면 "알 수 없음"과 마지막 오류 줄을 보입니다. 앱은 서버를 스스로 끄거나 설정을 바꾸지 않습니다. 자동 재시작은 서버별 설정(기본 꺼짐)이고, 10분에 3번이면 멈추며, 다시 해도 같은 원인과 시작 전 종료는 다시 시작하지 않습니다.
  - Java 9 이상 서버는 `-Xlog:gc:file=.nano/gc.log`로 시작합니다(과부하의 메모리 판단). Paper 26.3에는 "Can't keep up" 줄이 없어서 Paper와 Purpur는 플레이어 세션의 숨은 질의로 `tps`를 묻습니다.
- `server.properties`는 Java처럼 읽고 씁니다. 정규식으로 직접 고치지 않고 `readProperties`, `writeProperties`를 씁니다.
- Paper 설정 파일 위치는 버전마다 다릅니다(1.18까지 `paper.yml`, 1.19부터 `config/`, 26.1부터 월드 안). 버전별 경로를 확인합니다.

### 플레이와 참여 (`launcher.js`)

- 게임은 공식 Minecraft Launcher로만 엽니다. 앱은 Microsoft 계정을 다루지 않고, 런처를 설치하지도 않습니다. 런처가 없으면 다운로드 페이지를 안내합니다.
- 프로필은 `launcher_profiles.json`에 합쳐 씁니다. 런처의 프로필은 지우지 않습니다. 열린 런처는 메모리의 프로필로 파일을 다시 쓰므로, 열려 있으면 닫은 뒤 씁니다.
- Store 런처는 인자를 받지 않고 `%APPDATA%\.minecraft`만 씁니다.
- 참여 코드는 `nanostudio:join?addr=…&pack=…&name=…`이고, 붙여 넣기로만 받습니다. 프로토콜 핸들러를 등록하지 않습니다.
- 팩 주소는 https만, 팩 파일은 .mrpack 형식이 허용하는 호스트에서만 받습니다. 테스트 대역(`PYIDE_MC_SOURCES`)의 정확한 origin만 예외입니다.
- 팩 주소와 리디렉트가 가는 호스트, 붙여 넣은 참여 코드의 주소는 이름을 풀어 봅니다(`hosts.js`). 주소 하나라도 이 컴퓨터나 내 네트워크면 팩은 거부하고 코드는 먼저 묻습니다.
- 인스턴스 번역은 `options.txt`의 `resourcePacks`에 팩을 켭니다. 게임은 시작할 때 이 파일을 읽고 닫을 때 다시 쓰므로, 그 인스턴스의 게임이 실행 중이면 쓰지 않습니다.

### 백업 (`main/minecraft/backups.js`)

- 백업은 `<서버>/backups/<시각>_<이유>.zip` 하나이고 첫 항목이 `nano-backup.json`(앱과 마인크래프트 버전, 종류, level-name, 이유, 크기, 뺀 것)입니다. 월드와 설정 파일만 넣고 jar, mods, libraries, logs는 넣지 않습니다.
- 실행 중인 서버는 `save-off`, `save-all flush` 뒤 "Saved the game"을 보고 묶고, 끝나면 언제나 `save-on`을 보냅니다(전에 이미 꺼져 있었으면 그대로 두고, 멈추는 중인 서버에는 보내지 않습니다). 답이 없으면 묶지 않습니다. 묶는 중에 서버가 멈추거나 `stop`을 받으면 그 백업은 바로 버립니다. 멈추는 중인 서버의 백업 요청은 거절합니다(`stopping`).
- 되돌리기는 서버가 멈춘 뒤에만 합니다. 모든 항목의 CRC를 먼저 확인하고, 지금 상태를 "되돌리기 전"으로 백업하고, `.nano-restore/`에 풀어 이름 바꾸기로 바꿉니다. 중간에 실패하면 되돌리고, 앱이 죽어 끊기면 다음 시작이나 목록에서 `journal.json`으로 되돌립니다.
- `pyide-server.json`은 jar를 설명하므로 되돌릴 때 메모리와 JVM 옵션만 가져옵니다.
- 자동 백업은 Market 모드·플러그인 설치·업데이트·제거, 카드에 월드를 넣을 때, level-name이나 계정 확인을 바꿀 때, Repair 전에 렌더러가 `mc.backups.before`로 합니다. 풍선의 건너뛰기로 기다리지 않을 수 있습니다.

### Market

- Modrinth API를 메인에서 부릅니다. 설치한 파일은 기록해 두고, 이름이 다른 같은 모드는 sha1로 알아봅니다.
- 실행 중인 서버의 jar는 지우지 못합니다. 업데이트와 제거는 서버를 멈춘 뒤에 합니다.

### 플레이어 탭 (`main/minecraft/players/`)

- 서버의 콘솔과 파일만으로 동작하고, 서버에 아무것도 설치하지 않습니다. NanoBridge는 사용자가 동의할 때만 설치합니다.
- 플레이어의 채팅과 책 내용은 서버 줄과 같은 흐름으로 옵니다. 신뢰하지 않는 텍스트로 다룹니다. 답은 "다음 줄"이 아니라 모양으로 고르고, 여러 줄 답은 끝날 때까지 읽습니다.
- 저장은 모두 `store.js`의 `lineOf`를 지나고, 거기서 주소를 가립니다. 30일 보관합니다.
- 이름으로 보내는 명령(op, ban, whitelist)은 uuid를 함께 확인한 뒤 보냅니다.
- 명령 문구와 답은 1.20.1과 26.3이 다릅니다. 실제 jar의 `en_us.json`과 `javap`로 확인합니다.

### 공유와 비공개 공유

- 게임 서버의 공유는 기본이 비공개입니다. 참여 코드에 열쇠가 들어 있고, 열쇠는 인자, 로그, `ports:state`에 넣지 않습니다.
- 자동 공유는 게임 포트를 건너뜁니다. 메인이 게임 포트를 기억하고 자동 공개 공유를 거부합니다.
- 프로토콜을 바꾸면 `verify/private-share.mjs`가 방어를 뺀 사본에서 공격이 통과하는지까지 봅니다.

## 5. 테스트

### 대역

실제 서비스, 런처, 게임 대신 대역을 씁니다. 환경 변수로 연결합니다.

| 변수 | 대신하는 것 |
| --- | --- |
| `PYIDE_CRAFT_HOME` | Craft 작업 폴더 |
| `PYIDE_MC_SOURCES` | Mojang, PaperMC, Modrinth 등의 주소(로컬 웹 서버) |
| `PYIDE_MC_LAUNCHER` | 공식 런처(인자를 기록하는 node 스크립트) |
| `PYIDE_MC_STORE` | Microsoft Store 런처 |
| `PYIDE_MC_LAUNCHER_IMAGE`, `PYIDE_MC_GAME_IMAGE` | 런처와 게임이 열려 있는지 볼 프로세스 이름 |
| `PYIDE_MC_JAVA` | 서버를 돌릴 Java |
| `PYIDE_MC_DNS` | DNS(`hosts.js`의 이름 풀기). JSON 객체에 없는 이름은 찾지 못한 것으로 봅니다 |
| `PYIDE_CLAUDE_PATH` | 번역의 Claude Code CLI(물은 것을 기록하고 정해진 한국어로 답하는 node 스크립트) |

참여 코드나 팩 주소를 다루는 테스트에는 `PYIDE_MC_DNS`를 줍니다. 안 주면 `mc.example.test` 같은 테스트 주소를 실제 DNS에 묻습니다. Node 테스트는 `dns.promises.lookup`이 불리면 실패로 셉니다.

대역 런처를 쓰는 창에는 `PYIDE_MC_LAUNCHER_IMAGE`도 줍니다. 안 주면 사용자의 실제 런처가 열려 있을 때 결과가 바뀌고, 테스트가 사용자의 런처를 닫을 수 있습니다.

### 주요 테스트

| 테스트 | 내용 |
| --- | --- |
| `verify/minecraft-launcher-core.mjs`, `minecraft-content-core.mjs`, `minecraft-server-core.mjs` | 일반 Node. 메인 모듈을 IPC째 시험 |
| `verify/minecraft-launcher-core.mjs`의 인스턴스 번역 | 대역 Claude로 `resourcepacks/Nano Studio Korean`에 쓰기, 클라이언트 jar의 팩 형식, `options.txt`(사용자 팩의 순서와 다른 줄과 CRLF 유지, 줄과 파일 만들기, 목록이 아닌 줄은 그대로), 손상된 팩 파일 거부, 1.13 미만 거부, 그 인스턴스의 게임이 실행 중이면 거부, 번역 중에 시작한 게임은 다음 Play에서 켜기 |
| `verify/minecraft-content-core.mjs`의 Market 리소스 팩 | 팩이 낸 그대로의 언어 파일 복사본(`.nano/pack-lang`), 업데이트와 제거 뒤 우리 줄과 사용자가 고친 줄만 남기 |
| `verify/private-share.mjs`의 이름 검사 | 루프백·LAN·링크 로컬·IPv4 매핑 주소로 풀리는 이름, SRV 레코드, 그런 이름의 팩과 리디렉트를 방어를 뺀 사본과 함께 시험. 실제 DNS는 묻지 않습니다 |
| `verify/minecraft-launcher.mjs` | 인스턴스, 플레이, 참여, 팩 동기화, Craft 화면, 인스턴스 카드의 한국어 번역(대역 Claude, 취소, `options.txt`) |
| `verify/minecraft.mjs` | 서버 만들기, 실행, 드롭, Market, 설정, 리소스 팩, 프록시 |
| `verify/minecraft-players-core.mjs`, `minecraft-players-actions.mjs`, `minecraft-players.mjs` | 로그 해석, 동작 명령, 플레이어 탭 화면 |
| `verify/minecraft-antixray.mjs`, `minecraft-antixray-ui.mjs` | 안티 엑스레이 파일 고치기와 화면 |
| `verify/private-share.mjs`, `verify/port-sharing.mjs` | 비공개 공유 프로토콜, 포트 공유 |
| `verify/app-mode.mjs` | 시작 화면, 모드별 플러그인, Craft 셸 |
| `verify/minecraft-health-core.mjs` | 일반 Node. 원인 분류(실제 서버와 로더 형식의 예), 재시작 규칙, 멈춤 시계, 과부하 구간, 제안, 대역 프로세스로 예상한 종료와 비정상 종료, GC 로그 옵션, 다음 시작에 찾은 종료 |
| `verify/craft-health.mjs` | 한국어 창. 메모리 부족 카드와 고치기, 자동 재시작 한 번과 반복 멈춤, 응답 없음과 재시작, 과부하 상태와 제안 적용·되돌리기, 설정 탭 구역 |
| `verify/minecraft-backups-core.mjs` | 일반 Node. ZIP64(65,535개, 4 GB 넘김), 매니페스트, 보관 규칙, 손상된 백업 거부, 중간에 실패한 교체, save-off/save-on 순서(답 없음, 채팅 위조, 취소, 정지), 300 MB 묶는 동안의 이벤트 루프 |
| `verify/minecraft-backups.mjs` | 백업 탭(한국어): 멈춘 서버와 실행 중인 서버의 지금 백업, 실행 중인 서버의 되돌리기, 월드만 되돌리기, Market 업데이트 전 자동 백업과 건너뛰기, 두 테마와 900 px |
| `verify/craft-polish.mjs` | 새 서버 이름과 버전 목록, Market 재검색, 카드의 시작 중·중지 중, 콘솔 기록, 설정 탭의 레벨 칸과 검색, 저장 실패 때 안티 엑스레이 되돌리기 |

`MC_LAUNCHER_LIVE=1`(실제 로더 설치), `verify/minecraft-live.mjs`, `verify/port-sharing-live.mjs`, `verify/port-sharing-bore-live.mjs`는 실제 네트워크를 쓰므로 CI에 없고, 사용자의 승인 없이 돌리지 않습니다.

### 실제 게임 파일 확인

게임을 실행하지 않고도 이 PC의 Gradle 캐시에 있는 실제 jar를 읽을 수 있습니다(`~/.gradle/caches/fabric-loom/26.3`, `forge_gradle/.../1.20.1`). 문구는 `en_us.json`, 동작은 `javap`로 클래스를 읽어 확인합니다. 대역은 우리가 쓴 형식만 재현하므로, 줄 형식과 문구의 가정은 실제 파일로 확인합니다.

## 6. 하지 않는 것

- Minecraft EULA에 동의하지 않습니다. 테스트도 실제 EULA를 받지 않습니다.
- 테스트에서 실제 Minecraft Launcher나 게임을 실행하지 않습니다. `javaw.exe`를 컴퓨터 조작으로 다루지 않습니다.
- 어떤 계정에도 로그인하지 않습니다.
- 실제 모드팩 서버를 만들지 않습니다.
- bore.pub에 접속하거나 live 테스트를 돌리지 않습니다. 공개 터널이 열리므로 사용자의 승인이 필요합니다.
- 대역으로 확인한 것과 실제로 확인한 것을 구분해서 보고합니다.
