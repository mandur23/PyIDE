# Nano Studio

[![CI](https://github.com/mandur23/PyIDE/actions/workflows/ci.yml/badge.svg)](https://github.com/mandur23/PyIDE/actions/workflows/ci.yml)

Windows용 앱 하나에 두 가지 앱이 들어 있습니다. 시작할 때마다 고릅니다. Electron 38과 Monaco 에디터로 만들었습니다.

- **Nano Studio Code**: PyCharm 스타일의 Python IDE (이전 이름 PyIDE)
- **Nano Studio Craft**: 마인크래프트 앱. 공식 Minecraft Launcher로 모드를 넣어 플레이하고, 서버에 참여하면 서버의 모드가 자동으로 맞춰지며, 서버를 직접 열 수도 있습니다.

PyIDE를 쓰던 컴퓨터에서 처음 시작하면 PyIDE의 설정, 플러그인, 인터프리터 목록을 복사해 옵니다 (`%APPDATA%\PyIDE`는 그대로 둡니다).

**설치 파일 다운로드:** [NanoStudio-Setup.exe](https://github.com/mandur23/Portfolio-Nano-/releases/download/nano-studio/NanoStudio-Setup.exe) · [릴리스 페이지 (EXE / MSI)](https://github.com/mandur23/Portfolio-Nano-/releases/tag/nano-studio)

설치 파일에는 코드 서명이 없어 Windows SmartScreen 경고가 뜰 수 있습니다 (추가 정보 → 실행). EXE로 설치하면 앱 안에서 자동으로 업데이트됩니다.

## 주요 기능 (Code)

- **편집과 분석**: Pyright 자동 완성·정의 이동·사용 위치 찾기, ruff 검사와 서식, 맞춤법 검사, 라이브 템플릿, 인레이 힌트
- **리팩터링**: rope 기반 이름 변경·추출·인라인·이동, 프로젝트 트리에서 모듈 이름 변경/이동 시 import 자동 수정
- **실행과 디버그**: 실행 구성, debugpy 디버거 (조건부 중단점, 실행 중인 프로세스에 연결), Python 콘솔, 터미널
- **테스트**: pytest/unittest 실행, 자동 재실행 (Toggle Auto-test), 커버리지, 프로파일러
- **도구**: Git (커밋, 브랜치, 병합, 리베이스, 스태시, 로그), Jupyter 노트북, SQL/NoSQL 데이터베이스, HTTP 클라이언트, 데이터 뷰어 (pandas, NumPy, polars)
- **프레임워크와 환경**: Django·Flask·FastAPI 지원, venv·uv·Poetry 의존성 관리, WSL·SSH·Docker 원격 인터프리터, `.env` 파일
- **AI**: AI 채팅, 코드 완성, 인라인 편집, EmbeddingGemma 2 기반 로컬 의미 검색, Claude Code 연동
- **기타**: Search Everywhere, 편집 가능한 키맵 (PyCharm 기본 키맵), 스크래치 파일, 로컬 히스토리, 북마크, 한국어/영어 UI, 플러그인

## 소스에서 실행

필요한 것: Windows 10/11, Node.js 20 이상, Python 3.10 이상 (`python`이 PATH에 있어야 함)

```bash
npm install
npm run vendor
npm start
```

`npm run vendor`는 함께 배포되는 debugpy와 ruff를 `vendor/`에 설치합니다.

## 설치 파일 빌드

```bash
npm run dist
```

`dist/`에 `NanoStudio-Setup-<버전>.exe` (NSIS)와 `NanoStudio-<버전>.msi`가 만들어집니다.

## 릴리스

`CHANGELOG.md`에 `## <버전>` 절을 추가해 커밋한 뒤, `master`에서 실행합니다 (`gh` 로그인 필요).

```bash
npm run release -- 0.3.1 --dry-run   # 확인만: 빌드와 테스트 후 실행할 git/gh 명령을 출력
npm run release -- 0.3.1
npm run release -- 0.3.1 --publish-only   # 푸시 뒤에 멈춘 릴리스 이어 가기: dist의 파일만 업로드
```

버전 올리기, 빌드, 설치 파일 테스트, 커밋과 `v<버전>` 태그, 푸시, GitHub 릴리스 업로드(`latest.yml`은 마지막)까지 한 번에 합니다. 중간에 멈추면 어디까지 진행됐는지에 따라 되돌리는 방법이나 `--publish-only`로 이어 가는 방법을 알려 줍니다. 옵션은 [FEATURES.md](FEATURES.md)의 Updates 절에 있습니다.

## 테스트

푸시와 PR마다 GitHub Actions(`.github/workflows/ci.yml`)가 주요 테스트를 실행합니다. `verify/` 폴더의 스크립트가 Chrome DevTools Protocol로 실제 앱을 띄워 검사합니다. 창이 사용 중인 화면에 뜨지 않도록 별도 데스크톱에서 실행합니다.

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File verify/on-desktop.ps1 -Out verify/out/core.txt node verify/core.mjs
```

## 구조

기능별 플러그인 구조입니다. 화면 쪽은 `renderer/features/<기능>/`, 메인 프로세스 쪽은 `main/features/<기능>.js`에 있습니다. 자세한 구조와 API는 [FEATURES.md](FEATURES.md)에 있습니다.
