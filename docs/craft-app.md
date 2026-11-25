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
- 왼쪽 목록: 플레이, 서버 참여, 내 서버, 내 모드·플러그인, Market. 그 아래 설정, 정보. 만들 수 있는 것(새 인스턴스, 새 서버, 모드팩으로 서버 만들기, 새 모드, 새 플러그인)은 각 페이지 머리글에 있습니다.
- 편집기 탭(서버 설정, 플레이어 탭, 파일)을 열면 `body.mc-craft-tab`이 켜져 탭이 앱 전체를 덮습니다. 탭 안의 버튼이 탭 밖 화면으로 보내면 탭을 먼저 닫습니다.
- 설정 창에는 `craft: true`인 페이지만 나옵니다. `ide.debugger` 같은 Code 전용 API는 없습니다. `ide.openProject`와 `ide.closeProject`는 거부됩니다.
- 문구는 모두 한국어 -요 말투입니다. 메인의 영어 로그는 Run 탭에 두고 화면에는 한국어 단계를 보여 줍니다.
- 아래쪽 도구 창(서버 콘솔이 있는 실행 창, 터미널, 문제, 포트)과 오른쪽 알림 창은 탭이나 머리글 메뉴의 "새 창으로 열기"로 따로 띄울 수 있습니다(`renderer/core/popout.js`, Code와 같은 코어). 콘솔은 같은 객체가 옮겨 가는 것이라 서버 출력과 입력이 그대로 이어집니다. 서버 설정, 플레이어, 백업 탭은 편집기 탭이라 메인 창에 남습니다. 테스트는 `verify/popout-craft.mjs`입니다.

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
| `schedule.js` | 예약된 단계의 실행(알림, 재시작, 정지, 명령), 설정 탭의 "예약" |
| `mods.js` | 설정 탭의 "모드"·"플러그인": 목록과 스위치, 문제와 고치는 버튼, 시작할 때의 알림 |
| `modmaker.js` | "내 모드·플러그인" 페이지: 새 모드, 새 플러그인, 빌드, 서버·인스턴스에 추가, 모드 파일 추가, Code에서 편집. 클래스 접두사는 `mcw-`입니다(`mcm-`은 Market의 것) |
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
| `main/minecraft/schedule.js` | 예약 작업의 규칙과 시계(재시작, 정지, 명령) |
| `main/minecraft/mods.js` | 모드·플러그인 jar의 메타데이터 읽기, 켜고 끄기, 의존·충돌 확인 |
| `main/minecraft/modmaker.js` | 내 모드·플러그인: 로더의 예제 모드 받아 이름 바꾸기, Gradle 빌드와 취소, 플러그인 쓰기와 javac 빌드, 빌드한 jar를 서버·인스턴스에 넣기, Code로 열기 |
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

### 예약 (`main/minecraft/schedule.js`, 렌더러 `schedule.js`)

- 작업은 `pyide-server.json`의 `schedule` 목록입니다(`normalize`가 남기는 것만: 시각, 종류 restart·stop·command, 요일, 한 줄 명령, 20개까지).
- 시계는 메인이 갖고, 때가 된 단계를 창에 알립니다(`minecraft:schedule` `due`). 실행은 창이 합니다. 콘솔, 정지의 60초 규칙, 다시 시작하는 launch가 모두 창의 실행 세션에 있기 때문입니다. 재시작은 카드의 재시작과 같은 길(`mc.health.restart`)이라 비정상 종료로 잡히지 않습니다.
- 지나간 시각은 보충하지 않습니다. 서버가 시작한 뒤에 첫 알림이 오는 회차만 그 실행의 것이고(03:58에 켠 서버를 04:00에 재시작하지 않습니다), 90초 넘게 늦은 단계는 버립니다(절전, 시계 변경).
- 같은 분의 작업은 모두 실행하고 명령이 재시작·정지보다 먼저 갑니다. 프록시(Velocity)에는 `say`가 없어 알림 단계가 없습니다.
- 테스트는 `PYIDE_MC_SCHEDULE_MS`(`speed`, `warn`)로 시계를 빠르게 돌립니다(`verify/craft-schedule.mjs`).

### 모드와 플러그인 목록 (`main/minecraft/mods.js`, 렌더러 `mods.js`)

- jar의 메타데이터만 읽습니다: `fabric.mod.json`, `quilt.mod.json`, `META-INF/mods.toml`·`neoforge.mods.toml`, `plugin.yml`·`paper-plugin.yml`, `velocity-plugin.json`. 아무것도 실행하지 않습니다. TOML과 YAML은 이 파일들이 쓰는 부분만 읽는 작은 파서입니다(새 의존성 없음).
- jar 안의 jar(Fabric의 `jars`, Forge의 `META-INF/jarjar`)가 가져오는 모드도 "있는 것"으로 칩니다. Fabric API의 모듈처럼 다른 모드 안에 들어 있는 것을 없다고 하면 틀린 경고가 됩니다. `openZipBuffer`로 메모리에서 읽습니다.
- **틀린 경고보다 놓치는 쪽을 택합니다.** 읽지 못한 버전이나 범위는 맞는 것으로 칩니다. 권장(recommends, softdepend, optional)은 문제가 아닙니다.
- 끄기는 `<이름>.jar.disabled`로 이름 바꾸기입니다. Market의 기록(`market[id].files`)도 같이 바꿔서 Market이 그 프로젝트를 계속 알고 제거할 수 있습니다. 실행 중인 서버의 jar는 Java가 잡고 있어 거절합니다.
- 테스트는 직접 만든 jar로 합니다(`verify/craft-mods.mjs`). 실제 모드를 내려받지 않습니다.

### 내 모드·플러그인 (`main/minecraft/modmaker.js`, 렌더러 `modmaker.js`)

- 모드는 `<작업 폴더>/mods/<모드 ID>`이고 `pyide-mod.json`(`id`, `name`, `loader`, `mc`, `pkg`, `cls`, `java`, `created`)이 설명합니다. 서버에 묶이지 않습니다. 로더와 마인크래프트 버전이 맞는 서버와 인스턴스 어디에나 넣습니다.
- 새 모드는 로더가 공식으로 내는 예제 모드를 받아 이름만 바꿉니다(`sources.js`의 `modTemplate`). Fabric은 `fabric-example-mod`의 버전별 브랜치, Forge는 권장 빌드의 MDK zip, NeoForge는 `NeoForgeMDKs`의 버전별 저장소입니다. NeoForge에 그 버전 저장소가 아직 없으면 같은 해의 가까운 이전 버전 것을 받아 `gradle.properties`만 그 버전으로 바꾸고, 빌드를 손봐야 할 수 있다고 로그에 적습니다.
- 이름 바꾸기(`renameMod`)는 파일마다 한 번에, 긴 이름부터 바꿉니다. 사용자의 패키지나 이름에 템플릿의 이름이 들어 있어도 두 번 바뀌지 않습니다. 패키지 폴더는 ID가 들어간 이름이어도 다시 바꾸지 않습니다. 한글 이름은 `.properties` 파일에는 `\uXXXX`로 씁니다(Java가 ISO-8859-1로 읽습니다).
- 빌드는 모드 자신의 `gradlew.bat build`입니다(`--no-daemon`: 데몬이 남으면 몇 시간 동안 JDK와 모드 폴더를 잡습니다). JDK는 빌드 파일이 말하는 Java 버전의 것을 `JAVA_HOME`으로 줍니다(`buildJava`). Gradle 9는 Java 17 이상에서만 돕니다. Fabric의 Loom은 모드보다 새 Java로 빌드되어 있습니다(Loom의 `build.gradle`, 2026-11-24에 읽음: 1.18 이상은 Java 25, 1.11~1.17은 21). Fabric 예제 모드는 모든 브랜치가 최신 Gradle과 Loom을 쓰므로 1.20.1 모드도 JDK 25에서 Java 17용(`--release`)으로 컴파일합니다. `gradle.properties`의 `loom_version`으로 정합니다. 맞는 JDK가 없으면 Adoptium의 Temurin JDK를 받습니다(서버의 JRE와 같은 자리, `temurin-<버전>-jdk`).
- 취소는 프로세스 트리를 끝냅니다(`taskkill /T`). cmd.exe만 끝내면 Gradle의 Java가 남아 모드 폴더를 잡습니다. 앱이 끝날 때도 같습니다.
- 추가(`addTo`)는 빌드한 jar를 고른 곳의 `mods`에 복사합니다. 같은 모드 ID의 jar(파일 이름이 달라도, 꺼져 있어도)는 지우고 넣습니다. 파일을 Java가 잡고 있으면 그곳만 실패로 돌려주고 나머지는 계속합니다. Fabric 모드는 Quilt 인스턴스에도 넣을 수 있습니다. 다른 곳에서 만든 jar(`{file}`)도 같은 길로 넣습니다.
- 편집은 Nano Studio Code에서 합니다. "Code에서 편집"이 이 프로그램을 `--mode=code <모드 폴더>`로 한 번 더 띄웁니다. Craft에는 Java 언어 서버가 없습니다.
- 게임은 여기서 실행하지 않습니다(`runClient` 없음). 시험은 인스턴스에 추가하고 그 인스턴스를 실행해서 합니다.
- **Code 쪽(`main/features/craft-mods.js`, `renderer/features/craft-mods/`, Code 전용 플러그인).** "Code에서 편집"으로 연 폴더가 `<작업 폴더>/mods/<id>`나 `<작업 폴더>/plugins/<이름>`이면 Code의 오른쪽에 "마인크래프트" 도구 창이 뜹니다. 코드가 시작되는 파일과 알아 둘 파일을 설명과 함께 보여 주고(주 클래스는 저절로 열립니다), 빌드와 "게임에서 시험"(빌드, 인스턴스에 추가, 공식 런처 열기를 한 번에), "빌드해서 넣기"(서버)를 합니다. 작업 폴더는 그 폴더의 두 단계 위로 정합니다.
  - Code 프로세스는 `main/features/minecraft.js`를 모드 폴더를 처음 물을 때 `require`만 하고 `register`는 부르지 않습니다. 그 파일이 `modMaker`와 `launcher`를 내보냅니다. 서버가 실행 중인지는 Craft 프로세스만 알기 때문에 Code에서는 jar를 바꿀 수 없는 것(`inUse`)으로 압니다.
  - Fabric 예제 모드는 Fabric API를 요구하는데 새 인스턴스에는 없고 Market은 서버에만 설치합니다. 그래서 "게임에서 시험"은 넣은 뒤 모드가 요구하는 것 중 인스턴스에 없는 것을 jar의 메타데이터로 찾고(`missingIn`), Fabric API면 모드의 `gradle.properties`가 말하는 버전을 Fabric의 Maven 저장소(`sources.js`의 `fabricMaven`)에서 받아 넣습니다. 받은 파일이 `fabric-api`가 아니면 버립니다. 그래도 없는 모드는 이름을 알립니다.
  - 맞는 인스턴스(같은 로더, 같은 마인크래프트 버전)가 없으면 "시험용 인스턴스 만들기"가 `launcher.create`로 만듭니다.
  - Code에서 Craft를 띄우지 않습니다. 이 프로그램에는 단일 인스턴스 잠금이 없어서 두 번째 Craft가 같은 서버 폴더를 다루게 됩니다.
  - **테스트 클라이언트, HotSwap, 게임 화면(2026-11-25에 되살림, `renderer/features/craft-mods/game.js`).** 0.2.25부터 0.3.7 전까지 Code에 있던 기능입니다. "테스트 클라이언트"가 모드의 `gradlew runClient`를 Code의 Java 디버거로 실행합니다. init 스크립트(`modmaker.js`의 `INIT_SCRIPT`)가 `runClient`라는 JavaExec 작업에 JDWP 에이전트를 달고 `pyideClasspath`로 소스 세트의 클래스패스를 `build/pyide/classpath.json`에 씁니다. 켜 둔 동안 저장한 `.java`는 그 클래스패스로 컴파일해 디버거의 RedefineClasses로 게임에 넣고(메서드 안의 코드만: 그 밖의 변경은 이유와 함께 "다시 시작"을 안내), `assets/`와 `data/` 파일은 리소스 출력에 복사합니다. 게임 창은 디버그 포트를 가진 JVM으로 찾아 Code 옆에 두거나(기본), 창의 화면을 도구 창 안에 비춥니다(`main/minecraft/game-window.js`, `main/security.js`의 `allowWindowCapture`).
    - 이것은 모드의 개발용 게임입니다. Gradle이 스스로 마인크래프트를 받아 준비하고, 공식 런처를 거치지 않습니다. Craft 자신은 여전히 게임을 직접 켜지 않습니다.
    - Gradle은 `--no-daemon`으로 돕니다(빌드와 같은 이유). 설정 캐시는 끕니다(지난 실행의 디버그 포트가 남습니다).
- **플러그인**은 `<작업 폴더>/plugins/<이름>`이고 `pyide-plugin.json`(`name`, `api`, `pkg`, `server`, `mc`, `created`)이 설명합니다. 템플릿도 Gradle도 없습니다(Paper는 공식 Gradle 템플릿을 내지 않습니다). 새 플러그인은 내 Paper·Purpur·Velocity 서버 하나를 골라 주 클래스와 `plugin.yml`(Velocity는 `velocity-plugin.json`)을 직접 씁니다. 빌드는 그 서버의 API(Paper가 첫 시작 때 `libraries/`와 `versions/`에 푸는 jar, Velocity는 `server.jar`)와 플러그인의 `libs/`를 클래스패스로 `javac --release <서버의 Java>`를 돌리고 `jar`로 `build/libs/<이름>.jar`를 만듭니다. 서버를 한 번도 시작하지 않았으면 빌드를 거절하고 그렇게 말합니다. 고른 서버가 없어지면 같은 API의 다른 서버로 빌드합니다.
- 플러그인 폴더에 `.project`, `.classpath`, `.settings`를 씁니다. Code의 Java 언어 서버가 이 Eclipse 파일로 서버의 API를 압니다(Code의 일반 Java 프로젝트는 `src`를 소스 루트로 보므로, 이 파일이 없으면 `src/main/java`의 패키지가 어긋납니다). 바뀌지 않는 파일은 다시 쓰지 않습니다.
- 플러그인의 추가는 API가 같은 서버의 `plugins`로 갑니다(Paper 플러그인은 Paper와 Purpur, Velocity 플러그인은 Velocity). 같은 이름의 플러그인 jar는 바꿉니다.
- 테스트는 직접 만든 템플릿 zip과 Node로 쓴 `gradlew.bat`으로 합니다(`verify/craft-modmaker.mjs`). 실제 템플릿과 Gradle은 받지 않습니다. 플러그인은 러너의 실제 JDK로 스텁 API에 컴파일합니다.

### 메모리 추천과 서버 빌드 업데이트

- 메모리 추천은 `health.js`의 `createMemoryFit`입니다. GC 로그의 "정리 뒤 사용량" 최댓값이 서버가 쥐고 있는 메모리의 상한이고(young GC는 old 쓰레기를 포함하므로 실제는 더 적습니다), 그 1.6배와 2GB 중 큰 값을 담는 가장 작은 단계를 권합니다. 실행 20분, GC 8번이 지나기 전에는 말하지 않고, 서버가 버거워하는 중(`lagging`, `overloaded`)에도 말하지 않습니다. 늘리라는 조언은 과부하 쪽(`suggestions`)이 따로 합니다.
- 빌드 업데이트(`main/features/minecraft.js`의 `buildCheck`, `buildUpdate`, `buildRevert`)는 빌드 번호를 내는 종류(Paper, Purpur, Velocity)의 **같은 버전** 안에서만 합니다. 새 jar는 `server.jar.new`로 받아 체크섬을 확인한 뒤에만 바꾸고, 쓰던 jar는 `server.jar.old`와 `previousBuild`로 한 단계 남깁니다. 최신 빌드는 서버마다 6시간에 한 번만 묻습니다(목록을 읽을 때마다 카드가 묻기 때문입니다). 실행 중인 서버는 거절합니다.

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
| `PYIDE_MC_JAVA` | 서버를 돌릴 Java, 모드를 빌드할 JDK |
| `PYIDE_MC_CODE` | "Code에서 편집"이 띄우는 Nano Studio Code(띄우는 대신 인자를 적을 파일) |
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
| `verify/craft-modmaker.mjs` | 일반 Node와 한국어 창. 세 로더의 템플릿 이름 바꾸기, 빌드에 쓸 Java, 템플릿 주소, 새 모드 대화상자의 거절 문구, 빌드(대역 Gradle)와 실패·취소(프로세스 트리), 서버·인스턴스에 추가와 이전 빌드 교체, 서버 메뉴와 인스턴스 모드 창에서 추가, 다른 곳의 모드 파일, Code에서 편집, 플러그인(만들기, 실제 javac 빌드, 서버를 아직 시작하지 않은 경우, 컴파일 오류, 서버에 추가), 두 테마 |
| `verify/code-mods.mjs` | 한국어 Code 창. Craft가 만든 폴더만 모드로 보는지, 도구 창의 안내(파일과 설명, 단계), 주 클래스가 저절로 열리는지, 빌드(대역 Gradle), 게임에서 시험(인스턴스에 추가, Fabric API 받기와 검사, 런처 프로필), 없는 모드 알림, 서버에 넣기, 실패와 취소, 시험용 인스턴스 만들기, 플러그인 폴더, 다른 프로젝트에서 숨김, 두 테마, 테스트 클라이언트(대역 Gradle이 JDWP로 띄우는 Java 창), HotSwap(반영, 다시 시작이 필요한 변경, 컴파일 오류), 게임 창을 Code 옆에 두기, 리소스 복사, Code 안에 비추기(숨겨진 데스크톱에서는 화면이 바로 끊겨 픽셀 검사는 SKIP), 다시 시작과 끝내기 |
| `verify/popout-craft.mjs` | 한국어 창. 서버 콘솔이 있는 실행 창을 새 창으로 열기, 그 창에서 명령 입력과 단축키, 기본 창으로 되돌리기와 창 닫기, 재시작 뒤 복원, 도구 창 전부 열고 되돌리기 |

`MC_LAUNCHER_LIVE=1`(실제 로더 설치), `verify/minecraft-live.mjs`, `verify/port-sharing-live.mjs`, `verify/port-sharing-bore-live.mjs`는 실제 네트워크를 쓰므로 CI에 없고, 사용자의 승인 없이 돌리지 않습니다.

### 실제 게임 파일 확인

게임을 실행하지 않고도 이 PC의 Gradle 캐시에 있는 실제 jar를 읽을 수 있습니다(`~/.gradle/caches/fabric-loom/26.3`, `forge_gradle/.../1.20.1`). 문구는 `en_us.json`, 동작은 `javap`로 클래스를 읽어 확인합니다. 대역은 우리가 쓴 형식만 재현하므로, 줄 형식과 문구의 가정은 실제 파일로 확인합니다.

## 6. 하지 않는 것

- Minecraft EULA에 동의하지 않습니다. 테스트도 실제 EULA를 받지 않습니다.
- 테스트에서 실제 Minecraft Launcher나 게임을 실행하지 않습니다. `javaw.exe`를 컴퓨터 조작으로 다루지 않습니다.
- 어떤 계정에도 로그인하지 않습니다.
- 실제 모드팩 서버를 만들지 않습니다.
- 테스트에서 실제 모드 템플릿, Gradle, JDK를 내려받지 않습니다. 실제 빌드 확인은 사용자의 승인을 받고 합니다.
- Craft는 게임을 직접 켜지 않고 공식 런처로만 엽니다. 예외는 Code의 "테스트 클라이언트" 하나입니다(모드의 개발용 게임 `runClient`, 2026-11-25에 사용자가 되살리기로 정함). 테스트는 그 실제 게임을 실행하지 않고 대역 창을 씁니다.
- bore.pub에 접속하거나 live 테스트를 돌리지 않습니다. 공개 터널이 열리므로 사용자의 승인이 필요합니다.
- 대역으로 확인한 것과 실제로 확인한 것을 구분해서 보고합니다.
