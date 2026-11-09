# Nano Studio Cut 개발 가이드

Nano Studio Cut(영상 편집 앱)을 고칠 때 보는 문서입니다. 공통 구조와 작업 순서는 [development.md](development.md), 이 앱에서 겪은 문제는 [pitfalls.md](pitfalls.md)의 "공통"과 "Cut" 절에 있습니다. 모듈마다의 API는 [cut-architecture.md](cut-architecture.md)(영어)에, 사용자에게 보이는 기능 요약은 [FEATURES.md](../FEATURES.md)의 "Video editor" 절에 있습니다.

설계 문서:

- [video-editor-plan.md](video-editor-plan.md): 앱을 만들기로 한 계획과 결정
- [video-editor-features.md](video-editor-features.md): 기능 설계. 기능마다 [1](첫 출시), [2](프로 편집), [3](고급) 표시가 있습니다. 지금은 [1]과 [2]의 편집 키와 도구(들어올리기, 뽑아내기, 삽입 붙여넣기, 조금씩 옮기기, 그룹, 재생 위치의 클립 선택, 프레임 일치, 편집점 늘이기, 속도 늘이기, 슬립, 슬라이드, 펜), 자동화(자동 색, 덕킹과 클립 역할 [2], 장면 전환 감지 [3]), 패널(작업 내역, 마커, 오디오 미터 [2], 창 메뉴, 키프레임의 베지어와 정지 보간 [2]), 편의 기능(단축키 편집과 `?` 단축키 한눈에 보기 [2], 설정 페이지, 쓰지 않은 미디어 고르기와 지우기 [2], 없어진 미디어 찾기, 프록시 만들기 [1], 내보내기 대기열 [2], 5분마다 남기는 자동 저장 사본), 이 PC에서 하는 음성 인식(자동 자막, 대본 패널의 텍스트 편집, 군말 삭제 [3]), Claude로 하는 텍스트 AI(자막 다듬기와 번역, 유튜브 제목·설명·챕터, 하이라이트로 쇼츠 만들기, 말로 하는 편집 명령)를 만들었습니다.

## 1. 실행

```bash
npm start -- --mode=cut
```

- 시작 화면에서는 세 번째 카드(`#chooseCut`, "영상 편집")를 누릅니다.
- 작업 폴더는 `%USERPROFILE%\Nano Studio Cut`입니다. main.js가 만들고, 신뢰하고, 프로젝트(`ide.root`)로 엽니다. 안에 `Projects`(프로젝트 기본 위치), `Autosave`(자동 저장과 `.sessions` 세션 표시), `Cache`(썸네일, 파형, 프록시), 음성 분리를 처음 쓰면 `Media`(분리한 음성 WAV, 캐시 한도 밖)가 있습니다. 내보내기 저널은 `<userData>\cut-exports`에 있습니다.
- 테스트와 실험은 `PYIDE_CUT_HOME`으로 다른 폴더를 줍니다. 안 주면 사용자의 실제 프로젝트와 자동 저장이 열립니다.
- Cut에서 로드되는 플러그인은 필수 플러그인(diagnostics, notifications, problems, project-roots, run, settings, terminal)과 updater, cut입니다. Code와 Craft의 플러그인은 없습니다. installer, semantic, ai-* 플러그인도 없어서 음성 인식의 환경 준비와 모델 내려받기는 `main/cut/whisper.js`가 공용 AI 환경(`main/ai/runtime.js`)으로 직접 하고, Claude 요청은 `main/cut/ai.js`가 `main/ai/claude.js`(Claude Code CLI)로 직접 합니다.
- 시작 화면에서 Cut을 고르면 기본(내장) GPU 어댑터를 씁니다. 모드는 app ready 뒤에 정해져서 `force_high_performance_gpu` 스위치를 줄 수 없습니다. 이 PC에서는 AMD 내장 GPU가 잡힙니다. compositor는 `powerPreference: 'high-performance'`로 요청하지만, 어댑터는 그대로입니다.

## 2. 화면 구조

- `body.app-cut`가 켜지고 CSS가 IDE의 툴바, 스트라이프, 프로젝트 패널, 편집기 영역, 아래 툴 윈도우를 숨깁니다. `#cutHost`가 상태 표시줄 위의 창 전체를 채웁니다.
- 작업 폴더가 열리면 `ide.emit('cutReady', {host})`가 옵니다. `index.js`가 스크립트를 모두 로드한 뒤 `Cut.app`을 만들고 `Cut.ui.start(host, app)`를 부릅니다. 끝나면 `window.__cutReady = true`입니다.
- 화면은 Adobe Premiere Pro를 아는 사람이 다시 배우지 않고 편집하도록 Premiere의 배치, 키, 도구, 메뉴, 용어를 따릅니다. Adobe의 상표, 아이콘, 그림은 쓰지 않고 Cut의 모양과 아이콘을 씁니다. 무엇을 맞췄고 무엇이 다른지는 8절의 표에 있습니다.
- 메뉴 막대(`ui-menubar.js`): Premiere의 파일, 편집, 클립, 시퀀스, 마커, 그래픽 및 타이틀, 보기, 창, 도움말. 항목은 Cut 액션을 부르고(타임라인에 넘겨서 키보드가 어느 패널에 있든 활성 시퀀스에 적용) 그 키를 키맵에서 읽어 보여 줍니다. 메뉴가 열린 동안 다른 제목 위로 가면 그 메뉴가 열리고 ←/→로 옆 메뉴로 갑니다.
- 위 막대: 프로젝트 이름, 새로 만들기/열기/저장/다른 이름으로 저장, 실행 취소/다시 실행, 작업 영역 탭, 창 메뉴, 자동화 메뉴, 설정 메뉴(영상 편집기 설정, 키보드 단축키, 단축키 한눈에 보기), 가져오기, 내보내기. 좁으면 상표 이름, 창과 자동화의 글자, 저장 상태가 차례로 빠지고, 그래도 들어가지 않는 작업 영역 탭은 끝의 »에 들어갑니다.
- 작업 영역은 Premiere의 편집, 색상, 효과, 오디오, 캡션 및 그래픽에 Cut의 내보내기를 더한 여섯입니다(`WORKSPACES`). 편집은 위에 소스·효과 컨트롤과 프로그램, 아래에 프로젝트(효과, 마커, 작업 내역, 대본 탭), 도구 패널, 타임라인, 오디오 미터입니다. 색상은 Lumetri 스코프(`scopes`)·소스, 프로그램, Lumetri 색상·효과 컨트롤, 효과는 효과 컨트롤·소스, 프로그램, 효과·마커, 오디오는 오디오 트랙 믹서(`mixer`)·효과 컨트롤·소스, 프로그램, 기본 사운드(`essential`)를 위에 둡니다. 다른 파일이 주는 패널(`scopes`, `mixer`, `essential`)이 없으면 그 칸은 숨습니다. 칸마다 패널이 탭으로 있고, 칸 크기는 `cut.layout.<작업 영역>`에 저장됩니다. 패널은 한 번만 만들고 작업 영역 사이에서 옮깁니다.
- 도구 패널(`tools`, `ui-toolspanel.js`)은 프로젝트 패널과 타임라인 사이의 36 px 고정 칸(`fixed`, 탭 없음, 옆 분할선은 그 양옆 칸 사이를 옮김)에 세로로 섭니다. Premiere의 묶음(선택 / 앞으로·뒤로 트랙 선택 / 잔물결·롤링·속도 조정 / 자르기 / 밀어넣기·밀기 / 펜 / 손·확대/축소 / 문자)대로이고, 묶음 단추는 마지막에 쓴 도구를 보여 줍니다(`cut.toolGroups`). 누르고 있거나(350 ms) 오른쪽 클릭하면 도구와 키가 든 플라이아웃이 열립니다. 도구를 누르면 키보드는 그 전 패널로 돌아갑니다. 타임라인 막대의 가로 도구 단추는 선택 사항입니다(창 > 타임라인 도구 막대, `cut.timelineTools`).
- 작업 영역 탭의 오른쪽 클릭 메뉴와 창 > 작업 영역에 "이 작업 영역 재설정"(Reset to Saved Layout, Alt+Shift+0)과 "이 작업 영역에 변경 사항 저장"이 있습니다. 저장하면 분할선과 창 메뉴로 더한 패널이 `cut.layoutSaved`에 남고, 재설정하면 그것(없으면 기본 배치)으로 돌아갑니다. `와 Shift+`는 포인터 아래 칸과 키보드가 있는 칸을 작업 영역 가득 키우고 다시 누르면 돌립니다.
- 창 메뉴는 모든 패널을 보여 주고 지금 작업 영역에 있는 것에 체크를 합니다. 없는 패널을 고르면 그 작업 영역의 `dock` 칸에 닫기 표시가 있는 탭으로 들어가고, 작업 영역마다 `cut.addedPanels`에 남습니다. Find Action에는 `Cut.window.<패널>`로 있고, Premiere 키에서는 Shift+1(프로젝트), Shift+2(소스), Shift+3(타임라인), Shift+4(프로그램), Shift+5(효과 컨트롤), Shift+6(오디오 트랙 믹서), Shift+7(효과)입니다.
- 모니터 아래는 Premiere처럼 타임코드, 확대 비율과 재생 해상도, 길이, 그 아래 시간 막대, 그 아래 단추 줄입니다. 단추 줄은 Premiere의 기본 세트와 순서이고(프로그램: 마커 추가, 시작 표시, 종료 표시, 시작 표시로 이동, 1프레임 뒤로, 재생, 1프레임 앞으로, 종료 표시로 이동, 제거, 추출, 프레임 내보내기; 소스는 마커 추가가 없고 제거·추출 대신 삽입·덮어쓰기), 끝의 +가 단추 편집기를 엽니다(반복, 시작에서 종료까지 재생, 시작·종료 지우기, 편집 지점과 마커 이동 등, `cut.<source|program>.buttons`).
- 키보드 사전 설정(`cut.keyPreset`)은 "Adobe Premiere Pro"(새 사용자의 기본)와 "Nano Studio Cut (이전 키)"입니다. Premiere 쪽은 둘 다 가진 명령마다 Premiere의 Windows 기본 키를 쓰고, Cut에만 있는 명령은 Cut의 키를 둡니다. Cut을 써 본 사람(설정에 `cut.workspace`나 `cut.keys`가 있음)은 처음 실행 때 이전 키로 시작합니다. 키보드 단축키 대화상자의 "키보드 레이아웃 사전 설정"에서 바꾸면 모든 키가 그 세트로 다시 시작하고, 사람이 바꾼 키(`cut.keys`)는 그 위에 얹힙니다.
- 키는 마지막으로 누른 패널(`app.focusPanel`)로 갑니다. 입력칸이나 텍스트 레이어에 쓰는 중에는 단축키가 동작하지 않습니다.
- 설정 창에는 `craft: true`인 공용 페이지(모양, 언어, 플러그인, 업데이트)와 `cut: true`인 페이지만 나옵니다. Cut의 페이지는 "영상 편집기"(`ui-settings.js`) 하나입니다.
- 문구는 IDE처럼 -합니다/-하세요 말투입니다(Craft의 -요 말투가 아닙니다).

## 3. 파일 지도

### 렌더러 (`renderer/features/cut/`, `"modes": ["cut"]`)

| 파일 | 맡은 일 |
| --- | --- |
| `plugin.json`, `index.js` | 플러그인 정의. 스크립트와 CSS를 순서대로 로드하고 `cutReady`에 편집기를 시작 |
| `time.js` | 틱(초당 254,016,000,000), 프레임률, 프레임 맞춤, 타임코드 |
| `state.js` | `Cut.app`: 프로젝트 기록, 활성 시퀀스, 재생 위치, 선택, 도구, In/Out과 그 이벤트 |
| `codecs.js` | avcC, hvcC, AudioSpecificConfig, OpusHead 등 코덱 레코드 해석과 생성, 코덱 문자열, PCM 변환, 바이트 도구 |
| `mp4read.js`, `mkvread.js`, `audioread.js` | MP4/MOV(조각 MP4 포함), WebM/MKV, MP3/WAV/ADTS AAC 읽기 |
| `probe.js` | 파일 종류 판별과 Source, `sampleAtTime`, `keyBefore`, `readSample(s)` |
| `mp4write.js` | 내보내기 MP4 쓰기(mdat를 흘려 쓰고 moov는 끝에) |
| `captionwords.js` | 자막의 단어 시간(순수): 고친 글에 맞추기(`realign`), 시간에 강조할 단어(`lit`, `litAt`), 리플에 따라 옮기기(`remap`) |
| `remap.js` | 시간 다시 매핑의 속도 곡선(순수): 클립 시간에서 원본 시간(적분), 원본 시간에서 클립 시간, 범위, 원본 안에 머무는 길이, 곡선 편집(키 추가·삭제, 구간 속도, 속도 전환으로 나누기, 키 옮기기, 역방향, 정지, 다른 프레임률로 맞추기) |
| `model.js` | 프로젝트 모양, `validate`, `migrate`, `clipDuration`, `sourceTime`/`timelineTime`/`sourceSpan`/`sourceRoom` 같은 시간 계산(시간 다시 매핑 포함), 중첩 클립(`source.sequence`)의 원본 길이와 고리 검사(`sourceLength`, `nestLoop`, `nestUses`) |
| `keyframes.js` | 키프레임 값과 이징 |
| `masks.js` | 마스크(순수): 모양(타원, 4포인트 다각형, 펜), 경로 평탄화와 부호 거리, 덮임(페더, 확장, 불투명도, 반전, 마스크 모드), 시간의 값, GPU 데이터와 WGSL, Canvas 2D 덮임, 편집(이동, 꼭짓점 추가·삭제, 모서리↔부드러움, 핸들), 적중 시험 |
| `commands.js` | 편집 명령과 실행 취소 기록(`createHistory`) |
| `srt.js` | SRT/VTT 읽기와 쓰기, 인코딩 판별(UTF-8, UTF-16, CP949) |
| `lumetri.js` | Lumetri 색상의 기본 교정 뒤 섹션 계산(순수): RGB 커브(단조 3차 곡선, 표), `.cube` 3D LUT 읽기와 거부 이유, 프로젝트에 넣는 사본(해시 id, base64 float32), 삼선형 조회, HSL 보조의 범위(색조, 채도, 루마와 부드러움)와 그 안의 교정, 마스크 표시 |
| `effects.js` | 효과와 전환 레지스트리: 매개변수, WGSL, CPU 참조, Canvas 2D 힌트 |
| `scopes.js` | Lumetri 스코프의 집계(순수): 루마 파형, RGB 퍼레이드, YUV 벡터스코프(75%·100% 목표, 피부색 선), 히스토그램을 정수로 세는 CPU 함수와 같은 계산의 WGSL 컴퓨트 셰이더 |
| `textrender.js` | 텍스트 레이어와 자막 그리기(말하는 단어 강조 포함), 모션 프리셋(페이드, 올라오기, 타자기) |
| `media.js` | IPC 리더, 미디어 열기와 가져오기, 디코더 설정 |
| `decoder.js` | VideoDecoder 프레임 소스와 프레임 캐시, 오디오 트랙 디코딩 |
| `compositor.js` | 시퀀스 프레임 합성(WebGPU, 없으면 Canvas 2D, 중첩 클립은 그 시퀀스를 원본 시간에서 그린 그림), 효과의 표 텍스처(LUT, 커브), 스코프 집계(`scopes()`: GPU 컴퓨트 패스, 2D는 CPU) |
| `player.js` | 재생, 탐색, J/K/L 셔틀, 떨군 프레임 세기 |
| `thumbs.js` | 썸네일 띠와 파형 피크(`cut:cache*`에 캐시) |
| `presets.js` | 내보내기·시퀀스 프리셋, H.264/HEVC 레벨, 크기와 시간 추정 |
| `audiofx.js` | 클립 오디오 효과의 신호 처리(순수): RBJ 쿡북 바이쿼드(파라메트릭 이퀄라이저, 저음, 고음, 험 제거), 컴프레서, 미리 보는 하드 리미터, 노이즈 게이트, 효과 체인, 주파수 응답 |
| `audioengine.js` | 믹서(클립 효과 체인을 고정 구간으로 돌림, 중첩 클립은 그 시퀀스의 믹스를 원본처럼 읽음), 미리 듣기, 오프라인 렌더, 라우드니스 측정 |
| `export.js` | 내보내기(인코딩, 먹싱, faststart, 검증), 프레임 PNG, 유튜브 챕터 |
| `testsrc.js` | 테스트 미디어: 프레임 번호 블록, 1 kHz 삑 소리, 흰 번쩍임, 끊긴 톤, 장면 전환, 배경색 |
| `analyze.js` | 자동화의 신호 분석(순수): 레벨과 무음 구간, 스펙트럼 플럭스와 템포·박자, 색 히스토그램과 장면 전환, 자동 색, 덕킹 키프레임 |
| `ai.js` | 텍스트 AI(순수): Claude에 보낼 프롬프트(텍스트만), 답의 JSON 읽기와 한 번 다시 묻기, 대본 줄이기(고르게, 매번 같게), 자막 답 검사, 유튜브 챕터 고치기(0:00, 10초, 3개 이상)와 태그, 하이라이트 구간 검사와 쇼츠의 화면 채우기, 편집 명령의 허용 목록 검사와 명령으로 바꾸기, 언어별 자막 줄 나누기(ko, en, ja, zh, es), 글자 단위 비교 |
| `speech.js` | 음성 인식 단어 다루기(순수): 30초 창과 이음매 합치기, 클립을 거쳐 타임라인 시간으로, 자막 줄 나누기(한국어 18자, 두 줄, 6초), 군말과 긴 쉼, 단어 삭제 구간, 검색 |
| `speakers.js` | 화자 구분(순수): 단어 시간에서 임베딩 창 만들기, 평균 연결 코사인 군집(NN-chain, 자동은 기준값, 또는 정한 수), 단어마다의 화자와 짧은 뒤집힘 고르기, 화자 구간과 손으로 바꾸기, 다시 구분할 때 예전 화자와 맞추기, 자막의 화자 이름과 색 |
| `ui-base.js` | `Cut.ui`의 바탕: 패널과 액션 등록, 패널 사이 끌어 놓기, 공용 위젯 |
| `ui-shell.js` | 위 막대, 작업 영역(Premiere 배치, 고정 칸, 숨는 칸, 탭 », 저장과 재설정, 프레임 최대화), 창 메뉴, 새로 만들기/열기/저장/사본 저장, 자동 저장, 복구, 닫기 확인 |
| `ui-menubar.js` | Premiere의 메뉴 막대: 파일, 편집, 클립, 시퀀스, 마커, 그래픽 및 타이틀, 보기, 창, 도움말 |
| `ui-toolspanel.js` | 도구 패널(`tools`): 세로 도구 막대, 묶음과 플라이아웃 |
| `ui-project.js` | 프로젝트 패널: 가져오기, 빈, 목록과 썸네일 보기, 오프라인과 다시 연결, 새 시퀀스 |
| `ui-monitors.js` | 소스와 프로그램 모니터, Premiere의 단추 줄과 단추 편집기 |
| `ui-export.js` | 내보내기 대화상자와 패널, 프레임 내보내기, 챕터 복사 |
| `ui-captions.js` | 자막 패널, SRT 가져오기와 내보내기, 자막 스타일(말하는 단어 강조, 강조 색과 모양), 불확실한 단어가 든 자막 표시(단어와 확신도, 확인함 표시), 보이는 자막 트랙(프로그램 모니터가 그리고 내보내기가 입히는 트랙, 바꾸면 `captionTrack` 이벤트) |
| `ui-keys.js` | 단축키(IDE 액션 `Cut.<id>`), 키보드 사전 설정(Premiere Pro와 이전 키), 기본 편집 동작 |
| `ui-timeline.js` | 타임라인(트랙 헤더(Premiere 순서, 트랙 높이 키), 눈금자, 클립, 전환, 도구(속도 늘이기, 슬립, 슬라이드, 펜 포함), 끌기와 트림, Alt 끌기 복제, 그룹 고르기, 트랙 위·아래로 옮기기, fx 배지와 클립의 시간 다시 매핑 > 속도 줄), `Cut.ui.edit`, `Cut.ui.timeline`, `Cut.ui.timelineTools` |
| `ui-controls.js` | 효과 컨트롤: 속성, 시간 다시 매핑 > 속도, 효과 매개변수, 키프레임 줄 |
| `ui-effects.js` | 효과 패널: 분류, 검색, 즐겨찾기, 기본 전환 |
| `ui-text.js` | 텍스트 패널: 레이어, 글꼴, 스타일, 저장한 텍스트 스타일, 모션 프리셋 |
| `ui-color.js` | Lumetri 색상 패널: 접히는 섹션(기본 교정과 화이트 밸런스 스포이트·자동, 크리에이티브의 모양(LUT 불러오기와 강도), 커브(RGB 커브 편집 사각형), HSL 보조(스포이트, 범위, 마스크 표시, 교정), 비네트). 비네트 말고는 모두 클립의 Lumetri 색상 효과(`color.basic`) 하나를 고칩니다 |
| `ui-scopes.js` | Lumetri 스코프 패널: 프로그램 모니터 화면의 파형(루마), RGB 퍼레이드, 벡터스코프 YUV, 히스토그램. 모니터가 그릴 때마다 다시 세되 멈춤 40 ms, 재생 중 150 ms(2D는 300 ms)에 한 번까지(재생 중에는 픽셀의 4분의 1만), 화면에 있을 때만 |
| `ui-overlay.js` | 프로그램 모니터 위의 이동, 크기, 회전 손잡이와 제자리 텍스트 편집 |
| `ui-masks.js` | 프로그램 모니터 위의 마스크 편집(꼭짓점, 핸들, 마스크 이동, 페더·확장 손잡이와 안내선, 펜)과 고른 마스크 상태(`Cut.ui.masks`) |
| `ui-auto.js` | 자동화 메뉴(위 막대와 클립 메뉴)와 대화상자, 진행 상자: 무음 구간 삭제, 장면 전환, 박자, 음량 맞추기, 클립 음량, 덕킹, 자동 색, 오디오 역할 |
| `ui-history.js` | 작업 내역 패널: 실행 취소 단계 목록, 누르면 그 단계로 한 번에 이동(`history.goTo`) |
| `ui-meters.js` | 오디오 미터 패널: 메인 출력의 피크와 RMS, 피크 유지, -1 dBTP 선, 클리핑 표시 |
| `ui-mixer.js` | 오디오 트랙 믹서 패널(`mixer`): 트랙마다 팬 노브, M/S, dB 페이더(트랙 음량, 0~200%와 같은 값), 스테레오 미터, 마스터 스트립(`masterGain`); 오디오 작업 공간이 ui-shell.js에 없을 때만 더하는 오디오 작업 공간 |
| `ui-audiofx.js` | 효과 컨트롤의 주파수 응답 그래프(`Cut.ui.effectViews`: 이퀄라이저, 저음, 고음, 험 제거)와 기본 사운드 패널(`essential`: 오디오 유형, 선명도·험 줄이기·노이즈 게이트·하드 리미터 추가, 음성 분리, 자동 덕킹, 음량 맞추기) |
| `ui-markers.js` | 마커 패널(시퀀스와 클립 마커, 종류·색 거르기, 검색)과 마커 대화상자(`Cut.ui.markers.edit`) |
| `ui-shortcuts.js` | 키보드 단축키 대화상자(키보드 레이아웃 사전 설정, 기록, 지우기, 초기화, 겹치는 키 막기, 설정 `cut.keys`)와 `?` 단축키 한눈에 보기 |
| `ui-settings.js` | 설정 창의 "영상 편집기" 페이지(자동 저장 사본, 캐시 한도와 지우기, 기본 길이, 재생 화질, 프록시)와 위 막대의 설정 메뉴 |
| `ui-proxy.js` | 프록시 만들기 대기열(내보내기 엔진으로 720p H.264, 캐시 폴더, 재생 중 대기, 취소)과 가져올 때 권하는 막대 |
| `ui-queue.js` | 내보내기 대기열과 그 패널(내보내기 작업 공간): 하나씩 실행, 위·아래로, 취소, 다시 시도, 지우기, 폴더 열기 |
| `ui-speech.js` | 음성 인식: 처음 쓸 때의 내려받기 대화상자, 소리 읽기(16 kHz 모노)와 창별 인식, 미디어 파일마다의 대본 캐시, 자동 자막, 군말 삭제, 대본 패널(단어 시간, 재생 위치 단어 표시, 누르면 이동, 고른 단어 리플 삭제, 검색, 불확실한 단어의 물결 밑줄과 두 번 클릭 고치기), 다음/이전 불확실한 단어, 프로젝트의 단어 목록, 설정 페이지의 음성 인식 절 |
| `ui-speakers.js` | 화자 구분: 처음 쓸 때의 내려받기 대화상자, 화자 구분(인식하지 않은 것은 먼저 인식, 임베딩 캐시, 미디어 전체를 함께 군집, 한 단계), 대본 패널의 화자 줄(칩, 화자 수, 화자 구분 버튼)과 문단 화자 표시(화자 바꾸기, 이름 바꾸기, 단어 고르기), 화자별 자동 자막과 자막의 화자 색·이름 |
| `ui-ai.js` | Claude 텍스트 AI(자동화 메뉴, 자막 패널의 Claude 단추, Ctrl+J): 처음 요청 전 안내, Claude Code가 없거나 로그인하지 않았을 때의 설명, 진행 상자와 취소, 자막 다듬기(바뀐 곳 표시와 줄마다 고르기)와 번역(새 트랙), 유튜브 제목·설명·챕터(복사, 챕터 마커), 하이라이트 검토와 1080x1920 쇼츠 시퀀스, 편집 명령의 계획 미리 보기와 적용, 설정 페이지의 Claude 절 |
| `ui-voice.js` | 음성 분리(HTDemucs): 자동화 메뉴와 클립 메뉴의 음성 분리(고른 오디오 클립이 보컬 WAV를 재생, 한 단계), 프로젝트 패널의 음성 분리(가져오기만), 처음 쓸 때의 내려받기 대화상자, 소리 읽기(44.1 kHz)와 진행·취소, 음성 인식 전에 분리한 소리(`forSpeech`), 설정 페이지의 음성 분리 절 |
| `style.css`, `css/shell.css`, `css/timeline.css`, `css/panels.css`, `css/tools.css`, `css/speech.css`, `css/speakers.css`, `css/ai.css`, `css/audio.css`, `css/color.css` | 토큰과 영역별 모양(`color.css`는 Lumetri 색상의 섹션과 커브 사각형, Lumetri 스코프, `audio.css`는 오디오 트랙 믹서, 기본 사운드, 이퀄라이저 그래프, `tools.css`는 단축키, 설정, 프록시, 대기열, `speech.css`는 대본 패널과 음성 인식 대화상자, `speakers.css`는 화자 줄과 문단 화자 표시, `ai.css`는 Claude 대화상자와 검토 목록) |
| `locales/ko.json` | 한국어 |

### 메인

| 파일 | 맡은 일 |
| --- | --- |
| `main.js` | `--mode=cut`, `cutHome()`(`PYIDE_CUT_HOME`), 작업 폴더 만들기와 신뢰 |
| `main/windows.js`, `main/plugin-manager.js` | 창 제목, 시작 화면의 `cut` 선택, 플러그인 모드 `cut` |
| `main/features/cut.js` | `cut:*` IPC 등록, 폴더, 대화상자(`PYIDE_CUT_DIALOG`), 읽기 |
| `main/cut/paths.js` | 경로 검사(로컬 일반 파일, realpath, 네트워크 경로 거부)와 확장자 목록 |
| `main/cut/limits.js` | 채널마다의 크기 한도(읽기 64 MB, 쓰기 256 MB 등) |
| `main/cut/project.js` | `.ncut` 읽기와 원자적 쓰기, `.bak`, 자동 저장(최신 상태 하나와 사본 `keep`개), 세션 표시, 복구 목록 |
| `main/cut/sink.js` | 내보내기 파일 sink(`.part`에 쓰고 이름 바꾸기), 남은 조각 정리 저널 |
| `main/cut/faststart.js` | moov를 mdat 앞으로 옮기고 청크 오프셋 고치기 |
| `main/cut/cache.js` | 앱 전체 캐시와 LRU 정리(`cut.cacheLimitGB`, 기본 10) |
| `main/cut/find.js` | 다시 연결할 파일 찾기(`findMedia`)와 폴더 가져오기 목록(`listMedia`) |
| `main/cut/fonts.js` | 설치된 글꼴 목록(한국어 이름 포함)과 TTC 한 면을 떼어 낸 글꼴 데이터 |
| `main/cut/runs.js` | 표시를 쓴 실행이 아직 살아 있는지 판단 |
| `main/cut/whisper.js` | 음성 인식의 main 쪽: `cut:speech*` 채널, 공용 AI 환경 준비와 모델 내려받기(진행률, 오류 코드), 소리 임시 파일, Whisper 사이드카와 유휴 해제, 테스트용 가짜(`PYIDE_WHISPER_BACKEND=fake`) |
| `main/cut/ai.js` | 텍스트 AI의 main 쪽: `cut:aiStatus`, `cut:aiComplete`(요청 모양과 크기 검사, 모델 haiku/sonnet/opus, 3분 제한, `cut:aiProgress`), `cut:aiCancel`, 창이 닫히면 그 요청 취소 |
| `main/cut/speech-words.js` | 단어 시간을 소리가 있는 곳으로 좁히기(`refine`), 소리 덩어리 찾기와 가짜 모델의 단어(순수) |
| `main/ai/whisper_server.py` | Whisper 사이드카(transformers, CPU): JSON 줄 요청, 30초 창 하나씩, 단어 시간, 언어 알아내기, 취소 |
| `main/cut/speakers.js` | 화자 구분의 main 쪽: `cut:speakers*` 채널, 공용 AI 환경에 onnxruntime과 모델 내려받기(오류 코드), 음성 인식의 소리 임시 파일에서 창마다 임베딩, 사이드카와 유휴 해제, 테스트용 가짜(`PYIDE_SPEAKERS_BACKEND=fake`) |
| `main/ai/speaker_server.py` | 화자 임베딩 사이드카(WeSpeaker ResNet34-LM ONNX, onnxruntime, CPU): numpy로 계산한 Kaldi fbank(80 bin, 25/10 ms, Hamming, 디더 없음, 평균 빼기), 같은 길이 창을 묶어 실행, 취소 |
| `main/cut/voice.js` | 음성 분리의 main 쪽: `cut:voice*` 채널, 공용 AI 환경에 Demucs 패키지와 HTDemucs 모델 내려받기(진행률, 오류 코드), 소리 임시 파일, 보컬 WAV의 이름과 자리(작업 폴더의 `Media` 또는 `Cache`), `.part`에 쓰고 이름 바꾸기, 사이드카와 유휴 해제, 테스트용 가짜(`PYIDE_VOICE_BACKEND=fake`) |
| `main/ai/voice_server.py` | HTDemucs 사이드카(CPU): safetensors 메타데이터로 모델을 직접 만들고, 7.8초 구간을 4분의 1씩 겹쳐 하나씩 분리해 바로 WAV로 씀(메모리 일정), 진행 이벤트, 구간 사이에서 취소 |

### 코어에서 Cut에 닿는 곳

`renderer/core/ide.js`(`ide.appMode === 'cut'`, `body.app-cut`, `cutReady`), `renderer/core/styles.css`(`#cutHost`), `renderer/index.html`(`#cutHost`), `renderer/chooser.html`과 `renderer/core/chooser.js`(Cut 카드), `renderer/features/settings/index.js`(`craft: true`와 `cut: true` 페이지만), `renderer/features/updater/plugin.json`(모드에 `cut`).

## 4. 영역별 핵심 규칙

### 모든 모듈

- `ui-*.js`가 아닌 파일은 Node에서도 쓰는 순수 모듈입니다. Node 판별은 `const NODE = typeof module === 'object' && !!module.exports;`로 하고, 다른 모듈은 `NODE ? require('./x.js') : globalThis.Cut.x`로 얻습니다. `typeof require === 'function'`은 쓰지 않습니다. Monaco의 `loader.js`가 모든 모드의 페이지에 전역 AMD `require`를 만들어서, 앱에서 `Check dependency list!`로 로드가 실패하고 편집기가 시작되지 않았습니다.
- 로드 순서는 `index.js`의 `SCRIPTS`입니다. 로드할 때 다른 모듈을 읽는 모듈은 목록에서 앞에 있는 것만 씁니다. 함수가 실행될 때 찾는 `need(name)` 꼴이면 순서에 묶이지 않습니다.
- 모든 시간은 틱(Number)입니다. 컨테이너 단위는 읽을 때, 마이크로초는 WebCodecs에서, 초는 Web Audio에서만 바꿉니다.
- 렌더러는 파일을 직접 못 읽습니다(CSP). 모든 바이트는 `cut:*` IPC로 옵니다.

### 형식 (codecs, readers, probe, mp4write)

- 샘플은 `probe.readSample`/`readSamples`로만 읽습니다. Matroska의 header stripping 바이트(`samplePrefix`)를 붙여 주기 때문입니다. 오프셋과 크기로 직접 읽지 않습니다.
- `readSamples(reader, track, from, to)`는 slice처럼 `to`를 빼고 읽습니다. 디코딩 시작점은 `keyBefore`로 정합니다.
- `pcm-*` 오디오는 WebCodecs에 넘기지 않고 `Cut.codecs.pcmToFloat`로 풉니다. `track.description`은 받은 그대로 넘깁니다(VP9는 null).
- `rotation`은 똑바로 보이게 돌릴 시계 방향 각도입니다. `displayWidth/displayHeight`는 회전 전 값입니다.
- mp4write의 `timestamp`는 표시 시간(pts, 틱)이고, `compositionOffset`은 인코더가 순서를 바꿀 때만 줍니다. `addVideo`/`addAudio`의 Promise를 기다려 속도를 맞추고, 2 MB 넘는 샘플은 그때까지 바꾸지 않습니다.
- mp4write는 청크 오프셋을 co64로만 쓰고 mdat 헤더는 16바이트입니다. faststart는 co64를 co64로 두고, 넘치는 stco만 co64로 바꿉니다.

### 프로젝트와 명령 (model, keyframes, commands, srt)

- 패널은 프로젝트를 직접 바꾸지 않습니다. 모든 편집은 `app.history.do(Cut.commands.<명령>(...))`로 합니다. 명령이 실패하면 아무것도 바뀌지 않고, 성공한 명령 뒤에도 프로젝트는 `validate()`를 통과해야 합니다.
- 슬라이더 끌기, 트림 미리보기, 텍스트 입력은 `history.begin(label)`/`commit()`으로 한 단계로 묶습니다. 트림 미리보기는 이동마다 `cancel` + `begin` + `do`를 하고 놓을 때 `commit`합니다.
- 클립 길이는 `model.clipDuration`/`clipEnd`로만 셉니다. `(out - in) / speed`를 직접 쓰지 않습니다. 길이를 `model.QUANTUM`으로 반올림해서 속도가 1이 아니어도 프레임에 맞습니다. 그래서 시퀀스 프레임률은 `time.FRAME_RATES`만 받습니다.
- 타임라인 시간을 원본 시간으로 바꿀 때는 `model.sourceTime(clip, t)`만 씁니다. 역재생과 정지 프레임(`source.freeze`)을 처리합니다. 움직이는 값은 `Cut.keyframes.propValue(clip, path, t - clip.start, 기본값)`로 읽습니다.
- 명령 옵션은 중첩 객체로 넘깁니다(`move(seqId, ids, {delta, linked: false})`). Alt 동작은 `linked: false`입니다.
- 사람이 일으키는 오류는 영어 문장과 `err.code`로 옵니다. 화면에는 `tr(err.message)`로 보여 줍니다(`Cut.ui.exec`가 합니다).
- 연 파일은 `Cut.commands.createHistory(Cut.model.migrate(text))`로 만듭니다. 새 버전 파일은 `newer`, 프로젝트가 아니면 `notProject`로 거부합니다.
- `Sequence.masterGain`(dB, 기본 0)은 `setSequence`로 바꾸고, 믹서가 미리 듣기와 내보내기에 함께 적용합니다. 자동화의 음량 맞추기가 이 값을 정합니다.
- 클립의 `role`(null, `dialogue`, `music`, `effects`, `ambience`)은 `setRole`로 바꿉니다. migrate는 없거나 모르는 값을 null로 둡니다. 마커 종류에는 `beat`가 있습니다.
- 클립 그룹은 `clip.group`(`G<n>`)입니다. `group`/`ungroup`으로 바꾸고, `move`와 `remove`만 그룹 전체에 적용합니다(`linked: false`면 그 클립만). 자르기, 트림, 속도는 클립마다입니다. 클립 하나만 남은 그룹은 명령 뒤에 지워집니다.
- 슬립(`slip`), 슬라이드(`slide`), 속도 늘이기(`stretch`), 편집점 늘이기(`extendEdit`)도 명령입니다. 모두 `{applied, clamped}`를 돌려주고 막힌 이유(`source`, `neighbour`, `length`, `speed`)를 줍니다. 화면은 트림처럼 `liveEdit`(cancel + begin + do)으로 끌고 놓을 때 한 단계로 닫습니다. 끄는 동안 클립 객체가 바뀌므로 시작 위치는 끌기 시작할 때 저장해 둡니다.
- 기록의 한 지점으로 한 번에 가는 것은 `history.goTo(position)`입니다(변경 이벤트 하나). `onChange`는 묶음이 단계가 될 때 `commit`도 알리고, `app`은 이것을 `project`가 아닌 `history` 이벤트로만 내보냅니다. 단계 목록을 보여 주는 화면은 `history` 이벤트를 듣습니다.
- 키프레임을 베지어로 바꿀 때는 `Cut.keyframes.handles(옛 키프레임)`의 손잡이로 시작합니다(`Cut.ui.edit.easeList`). 모양이 그대로라 움직임이 튀지 않습니다. 베지어 키프레임에는 손잡이 `h`가 꼭 있어야 합니다(없으면 명령이 거부됩니다).
- 여러 명령을 한 단계로 묶을 때는 `Cut.commands.batch(label, [명령])`을 씁니다. 하나라도 실패하면 모두 되돌리고, 검사는 마지막에 한 번 합니다. 자동화의 결과는 모두 batch 하나입니다.
- 중첩 클립은 `source: { sequence }`입니다(형식 버전 2, 버전 1 파일은 그대로 열림). in/out은 그 시퀀스의 시간이고 `model.sourceTime`으로 읽으므로 속도, 역재생, 시간 다시 매핑이 그대로 적용됩니다. 원본 길이는 `model.sourceLength`(그 시퀀스의 길이, 클립의 `out`보다 짧지 않음)로만 셉니다. 미디어의 `duration`을 직접 읽는 새 클램프는 중첩 클립에서 0이 됩니다. 시퀀스가 자기 자신을 보이게 되는 배치(직접, 다른 시퀀스를 거쳐, 붙여넣기)는 명령이 `nestLoop`으로 거부하고 `validate`도 거부합니다. 화면은 명령 전에 `model.nestLoop`으로 같은 것을 거부해 한국어 안내를 보여 줍니다.
- 시간 다시 매핑은 비디오 클립의 `remap`(형식 버전 3, `remap.js`)입니다. 클립 시간 위의 속도 곡선이고(`{at, speeds, keys: [{t, ramp}], duration}`), 원본 시간은 그 적분입니다. 키 시간, 전환 길이, 길이는 시퀀스의 정수 프레임입니다. 다시 매핑된 클립의 in/out은 곡선이 닿는 가장 낮은·높은 원본 시간이고 `speed`는 1, `reverse`는 false입니다(곡선이 둘 다 가짐). 명령이 늘 맞춰 두므로 in/out을 읽는 옛 클램프는 그대로 맞습니다. 클립 길이는 `remap.duration`이고 `clipDuration`이 읽습니다. 원본 범위는 `model.sourceSpan`, 늘릴 수 있는 원본은 `model.sourceRoom`, 거꾸로(원본 → 타임라인)는 `model.timelineTime`으로만 셉니다. `speed`로 길이나 원본을 직접 계산하는 새 코드는 다시 매핑된 클립에서 틀립니다. 사람이 정하는 속도는 1~10000%(또는 0)이지만, 정지 옆 속도 전환 안을 자르거나 시작을 트림하면 새 곡선이 그 지점의 속도(1% 아래일 수 있음)로 시작하므로 저장된 곡선은 10000% 이하의 어떤 속도든 받습니다. 키 끌기는 속도가 아니라 길이를 제한해 정수 프레임 길이에서 나온 속도가 범위 안에 있습니다.
- 곡선은 `Cut.commands.setRemap(seqId, clipId, remap | null)` 한 명령으로 바꿉니다(레이블 Time Remapping). 화면은 `Cut.remap`의 편집 함수(`addKey`, `setSegmentSpeed`, `splitKey`, `moveKey`, `insertReverse`, `insertFreeze`, `removeKey`)로 새 곡선을 만들어 넘기고, 끌기는 `liveEdit`으로 한 단계입니다. Premiere처럼 뒤 클립을 밀지 않습니다(잔물결 없음). 길어진 곡선은 다음 클립까지만 클립을 늘이고 나머지는 클립 끝 뒤에 숨어 있다가 끝 트림으로 돌아옵니다. 연결된 오디오는 바뀌지 않습니다(비디오만). 키가 없는 곡선은 일정한 속도로 저장해 속도/지속 시간이 다시 됩니다. 속도/지속 시간, 역방향 속도, 속도 조정 도구는 다시 매핑된 클립을 `remap` 코드로 거부합니다.
- `nest(seqId, clipIds, {name, linked})`(클립 > 중첩…)는 한 단계입니다. 클립은 같은 트랙 자리와 가장 이른 클립에서 센 시간을 지키고, 편집점의 클립이 모두 옮겨지는 전환만 따라갑니다. 중첩 클립은 고른 클립 중 가장 낮은 비디오 트랙과 가장 낮은 오디오 트랙에 놓이고 그 구간의 다른 클립은 덮어씁니다. 중첩된 시퀀스를 지우면(`removeSequence`) 그 중첩 클립도 함께 지워지므로 프로젝트 패널이 먼저 어디에 쓰였는지 말하고 묻습니다. 안쪽 트랙은 바깥 트랙의 숨김, 음소거, 솔로를 그대로 받고, 볼륨과 팬은 중첩 클립이 놓이는 오디오 트랙의 값을 뺀 만큼 받습니다(그 트랙의 값은 중첩 클립에 적용되므로 두 번 줄지 않음).
- 마스크는 `addMask`, `setMask`, `removeMask`(`{effectId}`가 있으면 그 효과의 마스크)로 바꿉니다. 마스크 id(`m<n>`)는 클립 안에서 불투명도와 모든 효과를 통틀어 하나입니다. 키프레임 경로는 `masks.<id>.<path|feather|opacity|expansion>`과 `effects.<id>.masks.<id>.<...>`이고, 마스크 패스 키프레임은 꼭짓점 수가 같으면 꼭짓점마다 보간하고 다르면 다음 키프레임까지 앞의 경로를 유지합니다(`keyframes.mix`). 키프레임이 있는 경로에 꼭짓점을 더하거나 지우면 모든 키프레임에 같이 합니다(`masks.mapKeyframes`). 형식 버전 4이고 버전 1~3 파일은 그대로 열립니다.

### 엔진 (effects, textrender, media, decoder, compositor, player, thumbs)

- 디코더가 내준 VideoFrame은 빌린 것입니다. 쓴 뒤 `release(frame)`합니다. `decoder.stats().open`으로 남은 프레임을 셉니다.
- 하드웨어 VideoDecoder를 직접 쓸 때는 프레임을 output 콜백 안에서 그리고 닫습니다. 출력 프레임을 쥐고 있으면 디코더가 멈추고 `flush()`가 끝나지 않습니다.
- 프리페치는 디코더 안에 남은 프레임까지 세고 한 장씩 넣습니다. 안 그러면 캐시가 넘쳐 곧 보여 줄 프레임을 버립니다.
- `importExternalTexture(VideoFrame)`는 그 task가 끝나면 만료됩니다. 가져온 뒤 submit까지 await 없이 하고, 프레임은 `idle()`(onSubmittedWorkDone) 뒤에 반납합니다. compositor를 없애기 전에 `idle()`을 기다립니다.
- WebGPU의 layout `'auto'`는 셰이더가 읽지 않는 binding을 뺍니다. 모든 binding을 씁니다.
- 색 공식은 `effects.js` 한 곳에만 둡니다. UI는 `Cut.effects.whiteBalance`처럼 엔진 함수를 씁니다.
- Lumetri 색상은 `color.basic` 하나입니다(종류 이름은 예전 프로젝트와 자동 색 때문에 그대로). 기본 교정, LUT, 커브, HSL 보조 순서로 바뀌는 섹션만 한 패스씩 돌고, 패스의 `u.p[3].w`가 단계를 말합니다. LUT(3D)와 커브(1024 x 1) 표는 rgba16float 텍스처로 binding 4, 5에 두고 `textureLoad`로 읽어 셰이더가 보간합니다. GPU 샘플러의 8비트 가중치로 보간하면 CPU 참조와 달라집니다.
- LUT는 프로젝트에 넣습니다(`project.luts`, `commands.addLut`). 다른 PC에서 열어도, `.cube` 파일이 옮겨지거나 지워져도 같은 모양입니다. Cut 캐시의 사본은 캐시 한도(LRU)나 캐시 지우기로 사라지고 다른 PC에 없어서 쓰지 않습니다. id가 숫자의 해시라 같은 LUT는 한 번만 들어가고, 열 때 어떤 효과도 쓰지 않는 LUT는 빠집니다.
- 스코프의 GPU 집계와 CPU 집계는 같은 정수 계산이라 칸마다 같아야 합니다(`verify/cut-engine.mjs`). 계산을 바꾸면 `scopes.js`의 `analyze`와 `WGSL`을 함께 바꿉니다.
- Canvas 2D 대체 경로는 근사입니다. 색은 CSS filter로 sRGB 값에서 섞고, 비네트는 원형 그라데이션, 와이프는 가장자리가 딱딱하고, 가장자리 늘리기는 그리지 않습니다. 테스트 기대값도 sRGB 평균으로 둡니다.
- 다시 매핑된 클립의 plan 항목은 보통 항목입니다. `srcT`는 곡선의 원본 시간이고 `frameIndex`는 여전히 클립 안 프레임 번호입니다(정지 구간에서도 그레인이 바뀜). 프레임 혼합(`clip.sampling === 'blend'`, 시간 보간)은 항목의 `blend: {srcT, w}`로 다음 원본 프레임을 하나 더 디코딩해 선형 빛에서 섞습니다. 일정한 프레임률의 미디어에만 하고, 중첩 항목은 섞지 않습니다.
- 중첩 클립의 plan 항목은 `kind: 'nest'`, `sequence`, `srcT`, `layers`(그 시퀀스의 plan)입니다. 모든 항목에 `key`(위의 중첩 클립 id와 자기 id, 프레임 소스와 텍스트 캔버스의 키)와 `seqW`/`seqH`(놓인 시퀀스 크기)가 있습니다. 텍스트, 단색, 오류 그림의 크기는 바깥 시퀀스가 아니라 `seqW`/`seqH`로 정합니다. 중첩된 시퀀스의 배경은 그리지 않습니다(Premiere처럼 투명).
- 마스크(`masks.js`)는 클립 그림 안의 비율 좌표로 된 닫힌 베지어 경로입니다(꼭짓점마다 `[x, y, inX, inY, outX, outY]`). 클립의 모션 전에 적용되므로 위치, 크기, 회전을 따라갑니다. 불투명도의 마스크(`clip.masks`)는 모든 효과 뒤에 그림을 잘라 내고, 효과의 마스크(`effect.masks`)는 그 효과의 출력을 입력 위에 덮임만큼 섞습니다. 덮임 계산은 `masks.js` 한 곳에만 둡니다(CPU 참조 `coverage`, WGSL, 2D `canvasCoverage`). 새 효과는 마스크를 받을 수 없을 때만(가장자리 늘리기처럼 그림 안에 할 일이 없을 때) 정의에 `masks: false`를 줍니다. WebGPU는 프레임의 모든 마스크 데이터를 저장소 버퍼 하나에 256바이트 간격으로 넣습니다(바인딩 오프셋 정렬). 2D 대체 경로의 페더는 같은 기울기의 가우스 흐림이라 근사이고, 2D는 sRGB 값에서 섞습니다.
- 효과의 `canvas2d` 힌트가 `{ skip: true }`이면 2D는 그 효과 없이 그립니다(선명하게, 글로우, 포스터화, 색수차, 글리치, 렌즈 왜곡, 크로마 키, 필름 그레인). 슬라이드, 원형 조리개, 교차 확대/축소 전환은 2D에서 교차 디졸브로 그립니다. 새 효과는 2D로 할 수 있는 것(CSS filter 등)을 힌트로 주고, 못 하면 `{ skip: true }`를 줍니다.
- 무작위처럼 보이는 효과(그레인, 글리치)는 `Math.random`을 쓰지 않습니다. 픽셀과 클립의 프레임(`info.frame`)의 해시(`hash3`, CPU와 WGSL이 같은 u32 계산)로 만들어, 프레임 안 어느 시간에 그려도, 내보내기에서도, 테스트에서도 같습니다.
- 여러 패스 효과의 마지막 패스는 `tapOrig(uv)`로 효과의 입력을 읽습니다(binding 3). 비선형 단계(글로우의 밝은 부분 고르기)는 따로 패스를 둡니다. 간격 있는 블러 탭의 쌍선형 보간 뒤에 비선형 함수를 쓰면 CPU 참조와 달라집니다.
- 프레임 메모리 한도는 VRAM의 50%가 아니라 설정값(`decoder.setBudget`, 기본 1.5 GB)입니다. WebGPU가 VRAM 크기를 알려 주지 않습니다.
- 글꼴은 `cut:fonts`의 목록에서 고르고, TTC는 `cut:fontData(file, index)`로 받아 `new FontFace(name, data)`로 올립니다.

### 소리와 내보내기 (presets, audioengine, export, testsrc)

- 미리 듣기와 내보내기는 같은 믹서를 씁니다. 들리는 것이 내보내지는 것입니다.
- 중첩 클립의 소리는 그 시퀀스의 `mix`를 10초 블록으로 읽는 원본입니다. 원본 키에 중첩된 시퀀스들과 그 미디어의 JSON 해시가 들어 있어서 안을 고치면 바로 들리고, 옛 내용의 블록은 버립니다.
- 인코더에는 GPU 캔버스의 프레임을 줍니다. Chromium 인코더는 CPU 메모리의 프레임(willReadFrequently 2D 캔버스, RGBA 버퍼)을 full range YUV로 바꿔 파일이 어둡게 풀립니다. export는 WebGPU가 아닌 compositor의 프레임을 GPU 캔버스로 옮겨 넣습니다.
- AAC 비트레이트는 128, 160, 192 kbps만 씁니다(`Cut.presets.AUDIO_BITRATES`, 기본 192). Windows의 AAC 인코더(Media Foundation)가 96/128/160/192만 받고, 오류는 configure가 아니라 encode 중에 옵니다. export는 실제 인코딩으로 확인하고 낮은 쪽으로 내려갑니다.
- 라우드니스 측정은 `Cut.audioengine.measure`(흘려 가며 측정)로 합니다. `renderOffline`은 한 시간에 약 1.4 GB를 메모리에 둡니다.
- 클립 오디오 효과의 신호 처리는 `audiofx.js` 한 곳에만 둡니다. 등록부(`effects.js`)는 `dsp`로 처리기를 가리키고, 믹서가 미리 듣기와 내보내기에 같은 체인을 돌립니다. 효과 컨트롤의 그래프도 `audiofx.response`를 씁니다.
- 상태가 있는 처리(필터 메모리, 엔벨로프, 리미터의 미리 보기)는 믹서 블록 크기에 따라 결과가 달라지면 안 됩니다. 믹서는 체인을 클립의 첫 소리부터 센 고정 구간(32,768샘플)으로 돌리고, 구간마다 처리기의 `memory()`만큼(최대 4초) 앞에서 새 상태로 시작하고, 다음 구간과 512샘플을 교차 페이드합니다. 새 처리기는 `memory(params, rate)`와 `latency(rate)`를 정확히 돌려줘야 합니다. 지연은 체인이 빼고, 기억이 4초보다 길면 구간 사이가 조금 어긋납니다(이음매는 교차 페이드로 매끄럽습니다).
- 체인의 매개변수와 클립 게인은 블록이 아니라 클립의 첫 소리부터 센 32샘플 격자에서 읽습니다. 블록 시작에서 세면 블록 크기에 따라 소리가 달라집니다.
- 내보내기 파일은 `cut:writeOpen` → `cut:writeAt` → `cut:writeClose({commit})` → `cut:faststart` 순서로 씁니다. 취소나 실패하면 `.part`를 지웁니다.
- 결과 확인 문제(`verified.problems`)와 실패 문구는 영어이고, 화면에는 `tr(message, params)`로 보여 줍니다. 챕터는 `Cut.export.chapters(seq, {firstName: tr('Intro')})`로 만듭니다.
- 오류 코드는 문자열만 넘깁니다. DOMException의 숫자 `.code`가 `'9'`로 새어 나간 적이 있습니다.

### 메인 (`main/features/cut.js`, `main/cut/`)

- 렌더러가 준 경로는 `paths.js`를 지납니다. 로컬 일반 파일만, realpath로 확인하고, 확장자는 받은 이름과 실제 이름 둘 다 봅니다(8.3 이름이 다른 확장자를 숨깁니다).
- 네트워크 경로(`\\host\share`, `\\?\UNC\...`, 그런 곳을 가리키는 링크)는 아무것도 건드리기 전에 거부합니다. 열기만 해도 Windows가 NTLM으로 로그인합니다. 매핑된 드라이브 문자는 됩니다.
- 결과는 값으로 돌려줍니다(`{error, code}`). 예상되는 실패에서 던지지 않습니다.
- 쓰기는 정해진 확장자만 합니다. 프로젝트는 `.ncut`만, 내보내기는 mp4 m4a mov webm wav png jpg jpeg srt vtt txt만 씁니다.
- 대화상자 문구는 렌더러가 `tr()`로 번역해 넘깁니다(`title`, `filterName`, `allName`).

### 자동화 (`analyze.js`, `ui-auto.js`)

- 분석은 `analyze.js`의 순수 함수로 하고 Node(`verify/cut-analyze.mjs`)에서 합성 신호로 시험합니다. `ui-auto.js`는 샘플과 프레임을 읽어 넘기고 결과를 명령으로 바꾸기만 합니다.
- 소리는 `Cut.decoder.audioReader`로 10초 블록씩 읽습니다. 파일 전체를 디코딩하지 않습니다. 10분 PCM(115 MB)이 이 PC에서 약 1.7초, 가비지 수집 뒤 살아 있는 메모리는 약 22 MB 늘었습니다.
- 프레임은 프레임 소스에서 받아 64 px 폭으로 그리고 바로 `release`합니다. 영상을 디코딩하는 분석은 재생 중에 멈춰 기다립니다(`ctx.step()`).
- 분석은 한 번에 하나이고 오른쪽 아래 진행 상자의 취소로 멈춥니다. 취소하면 프로젝트는 바뀌지 않습니다.
- 색 공식은 여기에 두지 않습니다. 자동 색은 `Cut.effects.whiteBalance`와 `Cut.effects.cpu.basicPlan`을 씁니다.
- 무음 구간 삭제는 고른 클립(없으면 잠기지 않은 트랙의 소리 있는 클립 전부)이 모두 조용한 구간만 자릅니다. 음악이 깔려 있으면 대화 클립만 골라야 잘립니다. 미리 보기는 `Cut.ui.timeline.setOverlay`로 바뀔 트랙 위에 그립니다.

### 음성 인식 (`speech.js`, `ui-speech.js`, `main/cut/whisper.js`)

- 공용 AI 환경(`~\.pyide\semantic\venv`)과 사이드카 클라이언트(`runtime.startSidecar`)를 다시 씁니다. 새 환경을 만들거나 시스템에 pip로 설치하지 않습니다. 모델은 Hugging Face 캐시에 있고, 사이드카는 `HF_HUB_OFFLINE=1`로 캐시에서만 읽습니다.
- 내려받기는 대화상자의 내려받기 버튼을 눌렀을 때만 합니다(`cut:speechSetup`). 먼저 디스크 공간을 보고, 실패는 코드(`noPython`, `noTorch`, `disk`, `offline`, `busy`, `cancelled`, `failed`)로 돌려주어 화면이 쉬운 한국어로 설명합니다.
- 소리는 렌더러가 디코딩하고 섞어서 16 kHz 모노로 보냅니다(FFmpeg 없음). 블록마다 리샘플할 때 출력 샘플에 맞춘 시작과 필터 여유를 읽어 이음새가 없게 합니다. main은 임시 파일에 쓰고 닫을 때 지웁니다.
- 긴 소리는 30초 창, 5초 겹침으로 인식합니다. Whisper는 창 끝의 단어를 끝에 몰아 붙이고, 말하는 도중에 시작한 창의 첫 단어를 창 시작까지 늘입니다. 그래서 한 창의 단어는 끝 1.5초 전까지만 쓰고, 다음 창은 마지막으로 쓴 단어 뒤부터 씁니다(`mergeWindows`).
- Whisper의 단어 시간은 앞뒤 쉼까지 늘어납니다. main이 소리 크기로 단어를 좁힙니다(`refine`: 세그먼트 첫 단어는 마지막 소리 덩어리, 나머지는 가장 긴 덩어리). 그래야 긴 쉼 삭제와 자막 시간이 맞습니다.
- 대본은 미디어 파일(경로, 크기, 수정 시간)과 모델, 언어, 단어 목록마다 캐시에 두고 보여 줄 때마다 클립을 거쳐 타임라인 시간으로 바꿉니다. 편집한 뒤 다시 인식하지 않습니다. Whisper에 묻는 방법(서버의 디코딩 설정, 창 나누기)을 바꾸면 캐시 키의 버전(`speech|v2|…`)을 올려 옛 대본을 쓰지 않게 합니다. 단어 목록은 키 끝의 지문(`|t<해시>`)이고, 목록이 없으면 키가 예전과 같습니다. 확신도(`p`)가 없는 옛 대본의 단어는 표시하지 않습니다.
- 단어마다 Whisper의 확신도 `p`(단어 토큰 확률의 최솟값)가 서버에서 refine, 창 합치기, 캐시, 타임라인까지 따라갑니다. `Cut.speech.UNCERTAIN` 아래면 불확실한 단어입니다. 자동 자막은 그 단어를 자막의 `doubt`로 저장하고, 사람이 자막 글을 바꾸면 `setCaption`이 지웁니다(Claude 다듬기는 `doubt`를 그대로 넘깁니다).
- 단어 목록은 프로젝트 설정 `speechTerms`입니다(그 영상의 이름이라 프로젝트와 함께 다닙니다). 서버가 "용어, 용어, …"를 `prompt_ids`로 줍니다.
- 기본 모델은 whisper-large-v3-turbo입니다. 잡음 벤치마크(아래 7절)에서 small보다 글자 오류가 절반이지만 CPU 시간은 약 2.5배입니다.
- 자동 자막, 군말 삭제, 대본의 단어 삭제는 모두 `batch` 한 단계입니다. 리플 삭제는 무음 구간 삭제와 같은 `Cut.ui.auto.rippleRanges`를 씁니다.
- 자동 자막의 자막 항목은 단어마다의 시간(`words`, 자막 시작에서 센 틱, 프레임에 맞춤)을 가집니다. 단어는 글의 토큰(공백 없는 글자 묶음)과 하나씩 맞아야 하고(`Cut.captionwords.valid`, `validate`가 확인), 항목을 받는 명령은 모두 `realign`으로 글에 맞추고 못 맞추면 버립니다. 그래서 글을 고쳐도 틀린 단어가 강조되지 않습니다. 자막 항목을 만들거나 옮기는 새 코드는 `words`를 함께 넘기고(`ui-speech.js`의 범위 밖 자막 유지처럼), 시간을 바꾸는 명령은 `captionwords.remap`으로 단어도 옮깁니다. 불확실한 단어(`doubt`)도 같은 명령에서 `captionwords.remapDoubt`로 함께 옮깁니다(`commands.js`의 `timed`/`retime`). 단어와 달리 그 자막이 단어의 시작을 품을 때만 남고, 리플로 잘려 나간 단어의 표시는 지웁니다. 삽입으로 나뉜 자막의 뒤 조각에는 `speaker`도 넘깁니다.
- 자동 자막 대화상자의 "말하는 단어 강조"는 새 트랙의 `style.highlight`를 정하고 마지막 선택을 `cut.speech.highlight`에 남깁니다(기본 꺼짐). 이미 있는 "Auto Captions" 트랙을 다시 만들 때는 그 트랙의 상태로 시작하고 바꾸면 같은 batch에서 바꿉니다.
- 프로그램 모니터와 내보내기의 입히기는 자막 패널에 보이는 트랙(`Cut.ui.captions.trackOf`, 고르기 전에는 첫 트랙)을 씁니다. 내보내기 대화상자에는 트랙을 고르는 칸이 없어서, 보이는 트랙과 내보낸 영상이 같도록 내보내기도 그 트랙을 넘깁니다(`captionTrack`, 대기열 작업 포함).
- 강조는 그리는 시간을 프레임 시작으로 맞춘 뒤 고릅니다(`compositor.captionsAt`의 `t`). 재생 중 모니터는 프레임 사이의 시간도 그리므로, 이렇게 해야 내보낸 그 프레임과 같은 단어가 강조됩니다.

### 음성 분리 (`ui-voice.js`, `main/cut/voice.js`, `main/ai/voice_server.py`)

- 모델은 HTDemucs(`adefossez/HTDemucs`, 약 84 MB)의 보컬 줄기입니다. 공용 AI 환경을 다시 쓰고, 모델은 Hugging Face 캐시에서 `HF_HUB_OFFLINE=1`로만 읽습니다. 내려받기는 대화상자의 내려받기 버튼을 눌렀을 때만 합니다(`cut:voiceSetup`, 실패 코드는 음성 인식과 같습니다).
- torchaudio를 쓰지 않습니다. 사이드카가 safetensors 메타데이터로 `demucs.htdemucs.HTDemucs`를 만들고, 소리는 렌더러가 디코딩해 44.1 kHz float32로 넘기고, WAV는 soundfile로 씁니다. demucs는 `--no-deps`로 설치합니다(pitfalls).
- 긴 소리는 모델 구간(7.8초)씩 4분의 1을 겹쳐 분리하고 끝난 부분을 바로 씁니다. `demucs.apply.apply_model`은 결과 전체를 메모리에 모으므로 쓰지 않습니다. 입력의 직류 성분은 1초 이동 평균으로 빼고 다시 더하지 않습니다. HTDemucs가 구간 평균을 보컬에 더해 쉼이 -44 dBFS로 채워졌습니다(pitfalls).
- 보컬 WAV는 main이 이름과 자리를 정합니다. 음성 분리 명령은 작업 폴더의 `Media`(캐시 한도 밖), 음성 인식 전 분리는 `Cache`에 둡니다. 사용자 미디어 옆에는 쓰지 않습니다. 이름은 `<미디어 이름> voice <키>.wav`이고 키는 미디어 파일(경로, 크기, 수정 시간)과 범위의 해시라 같은 일을 다시 하지 않습니다. `.part`에 쓰고 끝나면 이름을 바꾸며, 취소와 실패는 `.part`를 지웁니다.
- 클립의 음성 분리는 오디오 클립의 소리만 바꿉니다(`Cut.commands.replaceAudio`, 자리, in/out, 속도, 키프레임, 효과, 링크, 그룹 그대로). 보컬 WAV는 미디어 길이까지 무음으로 채워 그 미디어의 어느 클립이든 들어맞습니다. 가져오기와 바꾸기는 `history.begin/commit` 한 단계입니다. 원본은 빈에 남고 실행 취소로 돌아옵니다.
- 대본 캐시는 미디어 파일마다, 화자 구간은 미디어 id마다라서 소리만 바꾸면 대본 패널이 비고 화자가 사라졌습니다. 보컬은 원본과 시간이 같으므로 바꾸기 전에 원본 파일의 대본을 보컬 파일의 키로도 저장하고(`Cut.ui.speech.carryTranscripts`), 같은 단계에서 화자 구간을 보컬의 id로 복사합니다(`setSpeakers`).
- 음성 인식 전 분리(`cut.speech.isolateVoice`)를 켜면 인식할 범위만 분리하고, 대본 캐시 키 끝에 `|iv`가 붙어 분리하지 않은 대본과 따로 캐시됩니다.

### 화자 구분 (`speakers.js`, `ui-speakers.js`, `main/cut/speakers.js`)

- 음성 인식과 같은 공용 AI 환경과 사이드카 클라이언트를 씁니다. torch는 필요 없고 onnxruntime, numpy, huggingface_hub만 씁니다. 모델(`Wespeaker/wespeaker-voxceleb-resnet34-LM`의 `voxceleb_resnet34_LM.onnx`와 `config.yaml`)은 Hugging Face 캐시의 로컬 파일로만 읽습니다. 내려받기는 대화상자의 내려받기 버튼을 눌렀을 때만 합니다(`cut:speakersSetup`).
- torchaudio가 환경에 없어서 fbank는 `speaker_server.py`가 numpy로 `torchaudio.compliance.kaldi.fbank`와 같은 순서로 계산합니다. WeSpeaker가 학습한 설정(16 kHz, 80 bin, 25 ms 창 10 ms 간격, Hamming 창, 디더 없음, 16비트 크기로 늘리기, 창마다 평균 빼기)을 바꾸면 임베딩이 틀어집니다. 평균 빼기를 빼면 영어에서 다른 화자끼리의 코사인이 0.27에서 0.51로 올라 구분이 무너졌습니다.
- 소리는 음성 인식의 임시 파일(`cut:speechOpen`, `cut:speechWrite`)로 보내고 `cut:speakersEmbed`가 그 파일의 창을 읽습니다. 렌더러가 다 쓴 뒤 닫습니다(`cut:speechClose`).
- 화자 구분은 프로젝트의 것입니다(`project.speakers`). 구간은 미디어 파일마다 원본 초로 두어서 자르기와 옮기기, 리플 삭제 뒤에도 다시 구분하지 않습니다. 모든 변경(화자 구분, 이름 바꾸기, 화자 바꾸기)은 `setSpeakers`가 든 batch 한 단계이고, 그 화자를 쓰는 자막의 `speaker`도 같은 단계에서 바뀝니다.
- 임베딩은 미디어 파일과 창 목록마다 Cut 캐시에 둡니다. 화자 수를 바꿔 다시 구분하면 소리도 모델도 쓰지 않고 군집만 다시 합니다. 다시 구분할 때 예전 화자와 겹치는 시간이 가장 긴 것끼리 맞춰 이름과 색이 남습니다.
- 자동 기준값과 창 크기는 아래 7절의 SAPI 벤치마크로 정했습니다(`Cut.speakers.DEFAULTS`). 실제 사람의 녹음으로는 확인하지 못했습니다.
- 자막의 화자 이름은 글에 넣지 않고 그릴 때 붙입니다(`decorate`의 `prefix`). 그래서 이름을 바꾸면 자막에도 바로 보이고, 단어 강조는 이름 부분을 건너뜁니다. SRT로 쓸 때만 글에 넣습니다(`written`).

### Claude 텍스트 AI (`ai.js`, `ui-ai.js`, `main/cut/ai.js`)

- 보내는 것은 텍스트뿐입니다. 대본(음성 인식) 또는 자막 텍스트와 그 시간, 클립·트랙·마커 이름과 시간입니다. 영상, 소리, 파일 경로는 보내지 않습니다. 프롬프트는 `ai.js`에서 만들고 `verify/cut-ai-core.mjs`가 경로가 들어가지 않는지 봅니다.
- Cut에는 ai-* 플러그인이 없습니다. 요청은 `cut:ai*` 채널(`main/cut/ai.js`)에서 `main/ai/claude.js`의 `complete`로 합니다. 결과는 값(`{ok, code}`)이고, `not-installed`와 `auth`는 설치와 로그인 방법을 쉬운 말로 보여 줍니다.
- 처음 요청 전에 무엇이 Claude(Anthropic)로 가는지 알리고, 계속을 누르면 설정 `cut.ai.acknowledged`에 남깁니다.
- Claude의 답은 믿지 않습니다. 모든 답은 JSON으로 읽고 `ai.js`가 검사합니다. 맞지 않으면 이유를 붙여 한 번만 다시 묻고, 그래도 안 되면 오류로 보여 주고 아무것도 바꾸지 않습니다. 유튜브 챕터(0:00, 10초, 3개)와 하이라이트 구간(시퀀스 안, 길이, 겹침)은 코드가 고치거나 거부합니다.
- 편집 명령은 허용 목록(`Cut.ai.OPS`)의 작업만 실행합니다. 모르는 작업, 모르는 필드(프로토타입 이름 포함), 없는 트랙과 클립, 시퀀스 밖의 시간은 거부합니다. 계획의 시간은 모두 적용 전 타임라인의 시간이고, 적용은 `batch` 한 단계입니다. 미리 보기를 거쳐야 적용됩니다.
- 결과는 모두 검토한 뒤 한 단계로 적용합니다(`Polish Captions`, `Translate Captions`, `Add Chapter Markers`, `Edit Command`는 batch, `Create Shorts Sequence`는 `history.begin/commit` 묶음).
- 긴 대본은 `Cut.ai.condense`가 정해진 방법으로 줄이고(약 3만 자), 줄였다는 것을 대화상자에 씁니다. 자막 다듬기와 번역은 줄이지 않고 60개씩 나눠 묻습니다.
- 테스트는 실제 Claude를 부르지 않습니다. `PYIDE_CLAUDE_PATH`로 `verify/fake-claude-cut.mjs`(프롬프트를 보고 정해진 답, 일부러 틀린 답 하나)를 씁니다.

### 화면 (`ui-*.js`)

- 클릭은 클립의 그룹 전체(항상)와 그 연결(연결된 선택이 켜졌을 때)을 고릅니다. Alt를 누르고 누르면 그 클립만 고릅니다. 그룹, 조금씩 옮기기, 삭제는 고른 것에 적용합니다.
- 새 키 중 Alt+←/→는 코드 편집기의 이전/다음 탭, Ctrl+G는 줄로 이동과 같습니다. Cut에는 코드 편집기가 없고 Cut 액션이 나중에 등록되어 타임라인에 키보드가 있을 때 Cut이 받습니다.
- 패널은 `Cut.ui.registerPanel`, 키 동작은 `Cut.ui.onAction`으로 등록합니다. 나중에 등록한 처리기가 먼저 받고, `false`를 돌려주면 다음으로 넘깁니다.
- 패널 사이 끌기는 `Cut.ui.dnd`의 정해진 payload(`media`, `source`, `effect`, `transition`, `generator`, `effectOrder` 등)로 합니다.
- 모든 문구는 `tr()`로, 색은 CSS 변수로, DOM은 `ide.util.el`/`textContent`로 만듭니다. 인라인 스크립트와 `innerHTML`은 쓰지 않습니다.
- 살아 있는 getter(`Cut.ui.workspace` 등)는 `Object.defineProperty`로 둡니다. `Object.assign`은 그 순간의 값으로 굳힙니다.
- 겹치는 안내 레이어는 기본을 `hidden`으로 둡니다. 모니터의 빈 화면 안내가 캔버스를 덮어 검게 보인 적이 있습니다.
- `ide.ui.dialog`는 Enter를 먼저 받습니다. OK에서 열린 숫자, 타임코드 입력칸을 먼저 blur해 값을 받습니다.
- IME로 조합하는 중에는 기록하지 않습니다. 텍스트 편집은 칸을 떠날 때 한 단계로 닫습니다.
- 저장 안 한 프로젝트의 닫기 확인은 `beforeunload`로 합니다. 내보내기 중에는 `window:setBusy`로 IDE의 닫기 확인에 들어갑니다.
- CSP `media-src`에 `blob:`이 없습니다. 페이지의 `<video>`로 내보낸 파일을 미리 볼 수 없습니다. 미리 보기를 넣으려면 CSP를 먼저 바꿉니다.

## 5. 테스트

### 대역

| 변수 | 대신하는 것 |
| --- | --- |
| `PYIDE_CUT_HOME` | Cut 작업 폴더(프로젝트, 자동 저장, 캐시) |
| `PYIDE_CUT_DIALOG` | 파일 대화상자. JSON 파일 `{pickMedia, pickFolder, pickProject, saveAs}`의 값을 창 없이 돌려줍니다(없으면 취소) |
| `PYIDE_CUT_FONT_DIRS` | Windows 글꼴 폴더. 글꼴 폴더의 JSON 목록입니다 |
| `PYIDE_WHISPER_BACKEND=fake` | Whisper 모델. Python 없이 소리 덩어리마다 단어 하나를 그 시간으로 돌려줍니다 |
| `PYIDE_CLAUDE_PATH` | Claude Code CLI. `verify/fake-claude-cut.mjs`를 실행하는 `claude.cmd`를 주면 정해진 답을 하고(`FAKE_CLAUDE_DIR`의 `scenario.json`으로 지연과 오류, `log.jsonl`에 보낸 프롬프트), `none`이면 설치되지 않은 것처럼 동작합니다 |
| `PYIDE_WHISPER_FAKE_SETUP` | 음성 인식 준비. `ok`, `offline`, `disk`, `noPython`이면 모델과 환경이 없는 것으로 시작하고 내려받기를 흉내 낸 뒤 그 결과로 끝납니다 |
| `PYIDE_SPEAKERS_BACKEND=fake` | 화자 임베딩 모델. Python 없이 창의 24개 주파수 에너지를 임베딩으로 돌려줍니다(높이가 다른 음은 다른 화자) |
| `PYIDE_SPEAKERS_FAKE_SETUP` | 화자 구분 준비. `ok`, `offline`, `disk`, `noPython`이면 모델이 없는 것으로 시작하고 내려받기를 흉내 낸 뒤 그 결과로 끝납니다. 실제 백엔드의 모델 없음은 `HF_HUB_CACHE`를 빈 폴더로 줍니다 |
| `PYIDE_VOICE_BACKEND=fake` | HTDemucs. Python 없이 소리를 그대로 보컬로 씁니다(`cut:voiceTestConfig({ delay })`로 소리 1초마다 지연) |
| `PYIDE_VOICE_FAKE_SETUP` | 음성 분리 준비. `ok`, `offline`, `disk`, `noPython`이면 모델과 패키지가 없는 것으로 시작하고 내려받기를 흉내 낸 뒤 그 결과로 끝납니다 |
| `HF_HUB_CACHE` | Hugging Face 캐시 폴더. 빈 폴더를 주면 실제 백엔드에서 모델이 없는 상태가 됩니다(내려받지 않고 설치 흐름을 시험) |

테스트 미디어는 `Cut.testsrc`나 테스트가 만든 바이트만 씁니다. 다운로드와 저작권이 있는 미디어는 쓰지 않습니다. 프레임 N은 숫자와 흑백 블록 줄로 N을 보여 주고(`readFrameNumber`로 읽음), 정해진 간격마다 1 kHz 삑 소리와 흰 번쩍임이 있습니다.

### 주요 테스트

| 테스트 | 종류 | 포트 | 내용 |
| --- | --- | --- | --- |
| `verify/cut-formats.mjs` | Node | - | 읽기와 쓰기 표 비교, 손으로 만든 상자들, 깨진 파일, Monaco `loader.js` 옆에서의 로드 |
| `verify/cut-model.mjs` | Node | - | 명령, 실행 취소, 무작위 2,000단계(중첩, 시퀀스 원본, 시간 다시 매핑 편집 포함), 시간 다시 매핑(프레임 경계에서 양쪽 방향의 시간, 50% 구간, 속도 전환의 정확한 적분, 역방향과 정지 구간, 길이와 다음 클립·원본 한계, 그대로인 연결 오디오, 자르기와 트림 뒤 프레임마다 같은 원본, 슬립, 속도/지속 시간·역방향·속도 조정 거부, 끄기, 프레임 혼합 설정, 24 fps로 붙여넣기와 프레임률 바꾸기, 저장과 열기, 버전 2 파일, 망가진 곡선, validate 거부, 다시 매핑된 중첩 클립), 중첩(트랙과 시간, 전환·키프레임·클립 마커, 빈, 링크, Alt), 중첩 클립의 트림·슬립·자르기·잔물결 삭제·속도, 고리 거부(직접, 세 번째 시퀀스, 붙여넣기, validate), 저장과 migrate(버전 1 → 2), 중첩된 시퀀스 삭제와 실행 취소, 동기 잠금, 링크, 그룹, 슬립·슬라이드·속도 늘이기·편집점 늘이기, 키프레임, SRT/VTT, migrate, 자막 단어 시간(고친 글에 맞추기, 강조할 단어, 옮기기·트림·리플·삽입·프레임률과 정확한 실행 취소, 리플·삽입·프레임률·시작 트림을 거친 불확실한 단어와 나뉜 자막의 화자, 파일, 단어 시간이 있는 무작위 명령) |
| `verify/cut-main.mjs` | Node | - | 모든 `cut:*` 채널(Electron 대역), 경로 공격, 자동 저장과 복구, sink, faststart, 캐시, 글꼴 |
| `verify/cut-engine-core.mjs` | Node | - | 효과 CPU 참조(새 효과마다 정한 픽셀의 값, 중립 매개변수에서 그대로, 그레인과 글리치의 프레임별 결과, 2D 힌트와 건너뛰기), 전환, compositor 계획(클립 프레임, 중첩 클립의 계획: 원본 시간의 레이어, 키, 자기 키프레임·효과·모션, 트림·자르기·역재생 뒤, 두 단계 중첩; 다시 매핑된 클립의 원본 시간과 frameIndex(속도 전환, 정지), 클립 앞 전환의 곡선, 프레임 혼합의 다음 프레임과 비율, 뒤로 갔다 앞으로 오는 다시 매핑된 중첩 클립), 모션 프리셋, 피크 |
| `verify/cut-export-core.mjs` | Node | - | 프리셋, 리샘플러와 WSOLA, 라우드니스, 믹서(중첩 클립이 담은 클립과 샘플마다 같음, 미리 듣기와 내보내기 블록, 볼륨·팬, 안의 편집, 시작 트림), testsrc, 내보내기의 순수 부분 |
| `verify/cut-audiofx-core.mjs` | Node | - | 오디오 효과: 필터마다 고른 주파수의 응답을 아날로그 이론(버터워스, 셸프, 피킹, 험 노치)과 비교, 그래프의 응답, 기본값의 비트 단위 통과; 컴프레서의 정적 곡선(무릎, 메이크업)과 어택·릴리스 시간; 리미터의 상한(트루 피크 포함), 클리핑이 아닌 매끄러운 게인, 상한 아래 통과와 회복; 게이트의 닫힌 시작, 열림, 홀드, 범위; 믹서에서 한 블록, 1~3,000샘플 블록, 중간 시작이 같은 샘플인지, 연속 실행과의 차이(이음매 없음), 효과 순서와 켜기 (`CUT_SRC_DIR`로 사본을 시험) |
| `verify/cut-analyze.mjs` | Node | - | 레벨과 무음 구간(최소 길이, 여백, 프레임), 클릭 트랙의 템포와 박자와 마디, 장면 전환과 번쩍임과 페이드 인, 자동 색(밝은 그림은 밝게), 덕킹 키프레임, 페이지 스크립트로 로드 |
| `verify/cut-speech.mjs` | Node | - | 음성 인식(모델 없이): 창과 이음매(끝에 몰린 단어, 반쯤 들은 시작), 속도와 역재생을 거친 타임라인 시간, 자막 줄 나누기(한국어 18자, 영어 42자, 두 줄 균형, 6초, 쉼, 문장 끝, 프레임), 군말과 긴 쉼, 단어 삭제 구간, 검색, 단어 시간 좁히기, main의 임시 파일·창·취소·준비 흐름·오류 코드, 페이지 스크립트로 로드 |
| `verify/cut-ai-core.mjs` | Node | - | 텍스트 AI(Claude 없이): 답의 JSON, 다시 묻기, 대본 줄이기(예산 안, 매번 같게), 프롬프트에 경로 없음, 자막 답 검사, 유튜브 챕터 고치기와 제목·태그, 하이라이트 검사와 쇼츠의 채우기·맞추기 배율, 편집 계획의 엄격한 검사(모르는 작업과 필드, 프로토타입 이름, 트랙, 시간, 선택)와 설명, 실제 프로젝트에 한 단계로 적용하고 정확히 되돌리기, ko/en/ja/zh/es 줄 나누기와 비교, `main/cut/ai.js`(검사, 진행, 취소, 시간 제한, 창 닫힘), `main/ai/claude.js`로 돌린 가짜 CLI와 `PYIDE_CLAUDE_PATH=none`, 페이지 스크립트로 로드 |
| `verify/cut-voice-core.mjs` | Node | - | `main/cut/voice.js`(Python 없이): 이름과 키, 임시 파일과 창 소유, 가짜의 WAV(44.1 kHz, 16비트, 미디어 길이까지 채움), 취소하면 WAV와 `.part`가 남지 않음, 캐시에 쓴 파일의 색인, 빈 Hugging Face 캐시에서 모델 없음과 `notInstalled` |
| `verify/cut-color-core.mjs` | Node | - | Lumetri 색상과 스코프 계산: 커브(정리, 직선 판별, 모든 점을 지나고 넘치지 않음, 정한 픽셀의 마스터와 채널), 좋은 `.cube`(TITLE, 주석, CRLF, 도메인, 입력 범위, 2·17·33·65점)와 나쁜 `.cube`(거부 이유와 줄 번호), LUT id와 base64와 복원, 채널을 바꾸는 LUT의 정확한 삼선형 조회, HSL 범위와 교정과 마스크 표시, Lumetri 순서와 기본값에서 할 일 없음; 75% 막대 여섯의 벡터스코프 각도와 목표, 회색, 피부색 선, 램프의 대각선(파형과 퍼레이드), 히스토그램, 프레임 상자와 간격, WGSL의 정수; `addLut`, 실행 취소, 잘못된 항목, 열 때 LUT 남기기와 빼기, 저장과 다시 열기; 페이지 스크립트; 거부 문구의 한국어 |
| `verify/cut-color.mjs` | 앱 | 9781 | Lumetri 색상과 Lumetri 스코프를 실제 마우스로: 색상 작업 영역 배치와 섹션, 재생 위치를 따라가는 스코프(회색·빨강·파랑 단색, 램프), 눈금자 스크럽, 1080p30 재생(약 150 ms마다, 떨군 프레임 없음, 화면 밖이면 세지 않음), 토글; 커브 점 더하고 끌기(한 단계, 모니터와 파형이 밝아짐), 빨강 채널, Ctrl+클릭, 두 번 클릭, Ctrl+Z; 대화상자 대역(`pickLut`)으로 LUT 불러오기(빨강이 청록으로), 강도, 나쁜 파일 둘의 거부와 그대로인 프로젝트, 실행 취소와 다시 실행, 저장하고 `.cube`를 지운 뒤 다시 열기; HSL 스포이트, 채도 0, 마스크 표시; 효과 컨트롤의 묶음; 화면 캡처 (`CUT_COLOR_ONLY`로 일부만) |
| `verify/cut-engine.mjs` | 앱 | 9753 | 프레임 정확도, 변형, 등록된 모든 효과와 CPU 참조 비교(Lumetri 색상의 커브, 프로젝트에 넣은 17점·33점 LUT, HSL 보조와 마스크 포함, 그레인과 글리치는 프레임별, 프레임 안 어디서나 같음), 스코프의 GPU 집계와 CPU 집계가 칸마다 같음(640, 레터박스 800, 간격 3의 1920 폭), 75% 막대의 벡터스코프 점, 램프의 대각선, 2D의 CPU 집계, 전환(정한 점, 모든 전환과 CPU 참조), 한글 텍스트, 자막, 재생, 프레임 누수, 2D 대체(건너뛴 효과, 반전 필터) |
| `verify/cut-export.mjs` | 앱 | 9754 | 실제 인코딩과 다시 디코딩, PSNR, 소리 위치와 음높이, 하드웨어/소프트웨어/HEVC, 취소, 라우드니스 |
| `verify/cut-shell.mjs` | 앱 | 9755 | 위 막대와 작업 영역, 저장과 복구, 가져오기, 모니터, 내보내기 대화상자, 자막, 단축키; Premiere의 작업 영역(탭 순서, 편집·색상·효과·오디오의 배치, Alt+Shift+숫자), 탭 메뉴의 재설정과 변경 사항 저장(Alt+Shift+0), `와 Shift+`의 프레임 최대화, 메뉴 막대(열기, 다른 제목 위로 옮기기, →, 시퀀스 > 편집 추가가 프로젝트 패널에 키보드가 있어도 타임라인에, 창 > 작업 영역, 파일 > 사본 저장) |
| `verify/cut-auto.mjs` | 앱 | 9757 | 자동화 메뉴와 클립 메뉴, 색 패널의 자동 버튼: 무음 구간 삭제와 미리 보기, 역할과 덕킹, 음량과 클립 음량, 박자 마커와 마커에 붙기, 장면 마커와 자르기, 재생 중 대기와 취소, 자동 색, 10분 파일의 분석 시간과 메모리 (`CUT_AUTO_ONLY`로 일부만) |
| `verify/cut-timeline.mjs` | 앱 | 9756 | 타임라인 동작과 키, 끌어 놓기, 효과 컨트롤, 효과와 색 패널(모든 효과와 전환이 분류 아래에, 크로마 키와 원형 조리개를 검색해 끌기), 오버레이와 IME, 클립 500개, 트랙 헤더(Premiere 순서와 이름, 동기화 잠금·출력·음소거·솔로·잠금을 실제 클릭으로, Ctrl/Alt/Shift+=와 -의 트랙 높이, 페이지가 확대되지 않음), 화면 캡처(효과 패널 포함) |
| `verify/cut-edit.mjs` | 앱 | 9759 | [2] 편집 키와 도구를 실제 키와 끌기로: 키가 `Cut.<id>` 액션인지(Find Action, 이전 키로), 타임라인 도구 막대(선택 사항), 대상·잠긴 트랙에서 들어올리기와 뽑아내기, 삽입 붙여넣기, 연결과 잠긴 트랙이 있는 조금씩 옮기기, 그룹(고르기, Alt 클릭, 끌기, 옮기기, 삭제, 해제), D, E, 속도 늘이기, 슬립(두 화면의 프레임을 픽셀로 읽음), 슬라이드, 펜 키프레임, 프레임 일치; Premiere 키(Ctrl+Shift+I/O/X, /, Ctrl+Shift+A, Shift+M, Ctrl+Shift+M, Ctrl+Alt+M, Ctrl+Alt+Shift+M, 대상 트랙의 ↑/↓와 모든 트랙의 Shift+↑/↓, Alt+↑/↓, Alt 끌기 복제, Ctrl+Shift+Space, Ctrl+N, Ctrl+B, 이전 키로 바꾸면 Alt+X) (`CUT_EDIT_ONLY`로 일부만) |
| `verify/cut-panels.mjs` | 앱 | 9762 | 작업 내역, 마커, 오디오 미터 패널과 창 메뉴를 실제 클릭과 키로: 작업 내역의 한 번에 이동, 흐리게 그린 뒤 단계, 1,500단계의 가상 목록; 마커 거르기, 검색, 클릭, 두 번 클릭, Delete; 눈금자의 마커 끌기(프레임, 붙기, 범위 끝)와 메뉴; 효과 컨트롤 줄과 타임라인 메뉴의 정지와 베지어, 정지 구간의 계단 모양(픽셀), 베지어 손잡이 끌기; 1080p30 시험 영상으로 미터의 피크, RMS, 유지, 클리핑 표시(캔버스 픽셀), 미터가 있을 때와 없을 때 떨군 프레임 (`CUT_PANELS_ONLY`로 일부만) |
| `verify/cut-mixer.mjs` | 앱 | 9778 | 오디오 작업 공간, 오디오 트랙 믹서를 실제 끌기와 클릭으로: 페이더(트랙 음량, 타임라인 머리의 %, 한 단계, Ctrl+Z, 위끝 +6 dB, Alt+클릭), 마스터 페이더, 팬 노브, M/S, 재생 중 트랙과 마스터 미터(두 트랙, 음소거, 캔버스 픽셀); 효과 컨트롤의 이퀄라이저 매개변수와 그래프, 칸에 입력, 기본 사운드(한 단계, 오디오 유형); 1 kHz를 깎은 이퀄라이저로 내보낸 M4A 측정; 미리 듣기와 내보내기의 샘플 비교; 다크·라이트 화면 캡처 (`CUT_MIXER_ONLY`로 일부만) |
| `verify/cut-nest.mjs` | 앱 | 9784 | 중첩 시퀀스를 한국어 화면에서 실제 마우스와 키로: 클릭으로 고른 클립(링크된 두 쌍, 그 사이 디졸브, 텍스트)의 클립 > 중첩…, 이름 대화상자, 한 단계, V1·A1의 중첩 클립, 프로젝트 패널의 새 시퀀스, 타임라인 픽셀의 중첩 색, Ctrl+Z와 Ctrl+Shift+Z, 액션 찾기와 입력한 이름; 중첩 전과 후의 프로그램 모니터 그림(다섯 시간의 testsrc 프레임 번호와 픽셀, 디졸브, 키프레임 불투명도, 텍스트), Canvas 2D에서도 같음, 중첩 클립의 불투명도; 두 번 클릭으로 그 시퀀스 탭과 보이던 프레임; 프로젝트 패널에서 다른 타임라인으로 끈 시퀀스; 소스 모니터에서 열기와 덮어쓰기(.); 고리 거부(놓기, 자기 타임라인, 명령)와 그대로인 프로젝트; 중첩된 시퀀스 삭제의 질문(쓰인 곳), 취소, 삭제, 편집 > 실행 취소; 중첩 위의 내보내기와 중첩된 시퀀스 내보내기의 프레임·픽셀·소리 비교; 화면 캡처 (`CUT_NEST_ONLY`로 일부만) |
| `verify/cut-mask-core.mjs` | Node | - | 마스크: 정한 픽셀의 덮임(참 원과 비교한 타원, 정확한 4포인트 다각형과 펜 삼각형, 빽빽하게 샘플한 3차 곡선과 비교한 부드러운 베지어), 페더, 확장(늘이기·줄이기), 마스크 불투명도, 반전됨, 두 마스크의 다섯 모드와 빼는 첫 마스크, 모양을 지키는 편집, 대칭·꺾인 핸들, GPU 데이터; 마스크 패스 키프레임(꼭짓점마다, 이징, 수가 다르면 유지, 모든 키프레임에 꼭짓점 추가); 명령과 거부(오디오 클립, 가장자리 늘리기, 너무 많음, 잘못된 값), 제거와 키프레임, 정확한 실행 취소, 자르기·붙여넣기·정지 프레임; 저장과 열기(버전 4), 버전 3 파일, 버전 5 거부, 망가진 마스크를 빼는 migrate, validate 거부; 마스크가 있는 중첩 클립과 시간 다시 매핑된 클립의 계획; 페이지 스크립트; 한국어 이름 |
| `verify/cut-mask.mjs` | 앱 | 9764 | 마스크를 실제 마우스와 키로: 효과 컨트롤의 타원 마스크 만들기와 4포인트 다각형 마스크 만들기(한 단계, 고른 마스크, 프로그램 모니터 픽셀의 안과 밖, Ctrl+Z, Ctrl+Shift+Z); 모니터에서 꼭짓점 끌기, 마스크 전체 끌기, 페더 손잡이(픽셀로 본 부드러운 가장자리, 안내선), 확장 손잡이, Alt+클릭, Ctrl+클릭, 윤곽선 클릭과 Ctrl+클릭, 밖 클릭; 클립 위치를 따라가는 마스크; 펜(모서리와 끈 부드러운 점, 첫 점에서 닫기, Esc); 타원 안의 반전 효과와 반전된 마스크 밖의 Lumetri 색상; 마스크 패스 스톱워치, 20프레임에서 끌어 만든 키프레임, 10프레임에서 반쯤 온 경로(픽셀); 모니터와 같은 내보낸 프레임; 화면 캡처 (`CUT_MASK_ONLY`로 일부만) |
| `verify/cut-remap.mjs` | 앱 | 9785 | 시간 다시 매핑을 실제 마우스와 키로: fx 배지의 시간 다시 매핑 > 속도, Ctrl+클릭으로 키 추가, 줄을 50%로 끌기(툴팁, 5초가 된 클립, 한 단계, 그대로인 다음 클립과 연결 오디오, 프로그램 모니터의 프레임 번호), Ctrl+Z와 Ctrl+Shift+Z, 20%에서 다음 클립까지만; 키의 반쪽을 끌어 10프레임 속도 전환(툴팁, 프레임); 탭의 Alt 끌기와 그냥 끌기, Ctrl 끌기 역방향과 Ctrl+Alt 끌기 정지의 프레임; 효과 컨트롤의 시간 다시 매핑 > 속도(재생 위치의 속도, 스톱워치, 키프레임 추가/제거, 입력한 속도, 끄기); 클립 > 시간 보간 > 프레임 혼합(두 프레임을 선형 빛에서 섞음); 내보낸 프레임이 모니터·곡선과 같음; 화면 캡처 (`CUT_REMAP_ONLY`로 일부만) |
| `verify/cut-tools.mjs` | 앱 | 9765 | 편의 기능을 실제 클릭과 키로: 단축키 편집(이전 키로: 기록한 키 바로 쓰기, 겹치는 키는 저장 못 함, 지우기, 초기화, 모두 초기화, 입력칸에서는 안 됨)과 `?` 한눈에 보기; 키보드 사전 설정(Shift+1/3/4, Ctrl+Alt+K, 대화상자에서 이전 키로 바꾸고 돌아오기, 한눈에 보기가 따라감); 도구 패널(자리와 세로, 클릭과 키보드 돌려주기, 누르고 있기·오른쪽 클릭의 플라이아웃과 키, 키로 바뀌는 묶음 단추, 창 메뉴의 타임라인 도구 막대); 모니터 단추 줄(Premiere 순서와 키, 마커 추가·제거·프레임 내보내기 클릭, 단추 편집기와 레이아웃 재설정); 설정 페이지(전환 길이가 Ctrl+D에, 재생 화질, 캐시 지우기, 사본 개수); 쓰지 않은 미디어 고르기와 지우기(한 단계, 실행 취소), 고른 폴더에서 다시 연결(크기, 길이); 프록시(가져올 때 권하기, 캐시의 720p H.264 15프레임 GOP, 모니터는 프록시·내보내기는 원본을 픽셀로, 지우면 원본, 재생 중 대기, 취소, 프로젝트마다 묻지 않기); 내보내기 대기열(순서, 나중 편집이 안 들어감, 위로, 취소, 다시 시도, 지우기, 닫기 확인); 말하는 단어 강조(프로그램 모니터 픽셀로 단어마다 첫 프레임과 그 앞 프레임, 스크럽, 재생 중 읽은 모든 프레임, 내보낸 파일의 프레임이 같은 단어, 자막 패널에서 글 고치기와 실행 취소·다시 실행, 다시 쓴 자막은 강조 없음, 상자 모양, 자막 패널에서 고른 두 번째 트랙을 멈춘 모니터가 바로 그리고 내보내기 패널이 그 이름을 보여 주며 입힘, 저장하고 다시 열기) (`CUT_TOOLS_ONLY`로 일부만) |
| `verify/cut-speakers-core.mjs` | Node | - | 화자 구분(모델 없이): 단어 시간의 창, NN-chain 트리와 전수 탐색 트리 비교, 자동과 정한 수, 떨어진 창, 번호; 단어 화자와 뒤집힘 고르기, 짧은 대답 남기기; 구간, 시간의 화자, 손으로 바꾸기, 다시 구분할 때 맞추기; `validate`, `setSpeakers` 실행 취소·다시 실행·`null`, 자막 명령의 화자, 저장과 다시 열기; 자막 이름과 색, SRT 이름; `main/cut/speakers.js`(가짜 임베딩, 잘못된 창, 취소, 빈 모델 캐시, 가짜 준비); 페이지 스크립트 |
| `verify/cut-speakers.mjs` | 앱 | 9766 | 화자 구분을 가짜 모델로 실제 화면에서: 화자 구분(자동, 세 화자, 문단과 색, 단어마다 화자, 한 단계); 칩 두 번 클릭으로 이름 바꾸기, 실행 취소와 다시 실행; 화자 2명 뒤 자동(다시 인식하거나 임베딩하지 않음, 이름 유지); 칩으로 화자의 단어 모두 고르기; 문단 화자 표시의 화자 바꾸기와 실행 취소; 화자 색과 이름이 든 자동 자막(자막마다 화자 하나, 합성 픽셀의 화자 색, SRT 이름, 자막 스타일에서 끄기); 저장하고 다시 열기; 빈 모델 캐시의 실제 백엔드(준비 대화상자, 내려받지 않음); 한국어로 인터넷 없음 설명; 화면 캡처 (`CUT_SPEAKERS_ONLY`로 일부만) |
| `verify/cut-whisper.mjs` | 앱 | 9768 | 음성 인식을 가짜 모델로 실제 화면에서: 처음 쓸 때의 대화상자(크기, 이 PC에서, 누르기 전에는 내려받지 않음, 취소, 진행률), testsrc 삑 소리로 자동 자막(두 창), 자막 패널 버튼과 In-Out 범위, 캐시, 모델을 읽는 동안의 안내, 대화상자의 말하는 단어 강조(처음에는 꺼짐, 새 트랙에 적용, 기억, 다시 만드는 트랙의 상태); 대본 패널의 클릭 이동, 재생 중 단어 표시, Shift+클릭, Delete로 연결된 트랙까지 리플 삭제와 실행 취소, Remove, 검색; 불확실한 단어(물결 밑줄과 확신도, 자막 패널 표시, Alt+]/Alt+[와 메뉴, 확인함, 고친 자막, 대본 단어 고치기와 확인, 표시 끄기); 단어 목록(자동 자막 대화상자, 단어 목록…, 프로젝트 설정, 새 대본과 캐시, 실행 취소 한 단계); 군말 삭제와 미리 보기; 설정 절; 창 메뉴; 인터넷 없음 오류의 한국어 설명; 화면 캡처 (`CUT_WHISPER_ONLY`로 일부만) |
| `verify/cut-ai.mjs` | 앱 | 9779 | Claude 텍스트 AI를 가짜 CLI로 실제 화면에서: 처음 안내(취소하면 아무것도 안 보냄, 계속은 기억), 자막 다듬기(바뀐 곳 표시, 하나 해제, 한 단계, 시간 그대로), 일본어 번역(새 트랙, 같은 시간, 16자 줄), 유튜브 메타데이터(챕터 고침, 복사, 옛 챕터를 바꾸는 챕터 마커), 자막이 없을 때 음성 인식을 권하고 대본으로 보내기(가짜 Whisper), 하이라이트(겹친 첫 답 거부 뒤 다시 묻기, 검토, 고른 구간의 1080x1920 시퀀스와 자막, 채우기, 실행 취소), Ctrl+J 편집 명령(무음과 미리 보기 표시, 처음 10초, 음악 6 dB, 허용 목록 밖 작업은 두 번 거부하고 오류, 모르는 필드는 다시 물어 고침, 편집 없음), 취소, 로그아웃 상태, 설정 절, 한국어로 Claude Code 없음 설명, 화면 캡처 (`CUT_AI_ONLY`로 일부만) |
| `verify/cut-voice.mjs` | 앱 | 9767 | 음성 분리를 가짜 백엔드로 실제 화면에서: 처음 쓸 때의 대화상자와 진행률, 자동화 메뉴의 음성 분리(작업 폴더 `Media`의 WAV, 원본 옆에는 쓰지 않음, 같은 빈에 가져오기, 오디오 클립만 새 소리, 자리·in/out·링크 그대로, 한 단계, Ctrl+Z/Ctrl+Shift+Z, 다시 하면 같은 파일), 취소(WAV, `.part`, 임시 파일, 미디어, 단계 모두 남지 않음), 프로젝트 패널의 음성 분리, 음성 인식 전 분리(자동 자막 대화상자와 설정의 체크, 캐시의 분리한 소리, 따로 캐시되는 대본); 실제 백엔드와 빈 `HF_HUB_CACHE`로 모델이 없을 때의 대화상자와 설정의 Download…(아무것도 내려받지 않음); `CUT_VOICE_REAL=1`이면 실제 HTDemucs (`CUT_VOICE_ONLY`로 일부만) |
| `verify/app-mode.mjs` | 앱 | 9758(Cut 부분) | `--mode=cut` 창, 작업 폴더와 신뢰, 플러그인, `__cutReady` |

- Node 테스트는 `node verify/cut-<이름>.mjs`로 돌립니다.
- 앱 테스트는 `launch({ fixture: 'core', port, name, mode: 'cut', env: { PYIDE_CUT_HOME: <임시 폴더> } })`로 띄우고 `window.__cutReady === true`를 기다립니다. 쓰는 모듈마다 `Cut[name]`이 있는지 먼저 확인합니다. 로드에 실패한 모듈은 쓰기 전까지 증상이 없습니다.
- 앱 테스트는 하나씩 숨겨진 데스크톱에서 돌립니다: `powershell -NoProfile -ExecutionPolicy Bypass -File verify/on-desktop.ps1 -Out verify/out/<이름>.log -TimeoutMinutes 20 node verify/<이름>.mjs`.
- 클릭은 실제 마우스 이벤트(`Input.dispatchMouseEvent`), 키는 `press`로 보냅니다. 창 크기는 실행마다 다르니 좌표는 매번 페이지에서 계산합니다.

## 6. 하지 않는 것

- FFmpeg, mp4box.js, 미디어용 npm 패키지를 쓰지 않습니다. 브라우저의 WebCodecs, WebGPU, Web Audio, Canvas 2D만 씁니다.
- 테스트에서 미디어를 내려받지 않고, 저작권이 있는 미디어를 쓰지 않습니다.
- 네트워크 공유(`\\nas\...`)의 미디어를 열지 않습니다.
- 시스템 전체 설정(레지스트리, 전역 환경 변수, subst, 프로토콜 핸들러)을 바꾸지 않습니다.
- HDR(PQ, HLG) 영상은 `hdr` 오류로 거부합니다.
- 대역(testsrc)으로 확인한 것과 실제 파일로 확인한 것을 구분해서 보고합니다.

## 7. 아직 없는 것

확인하지 못한 것:

- B 프레임이 있는 스트림. 이 PC의 H.264 VideoEncoder는 B 프레임을 만들지 않습니다. 디코더는 표시 순위로 프레임을 맞추지만 실행해 보지 못했습니다.
- 회전된 영상(90/180/270). 두 백엔드에 회전 코드는 있지만 mp4write가 회전 행렬을 쓰지 못해 시험 파일이 없습니다.
- 하드웨어 디코더가 오류를 낼 때 소프트웨어로 넘어가는 경로, 하드웨어 인코더가 내보내기 중간에 실패할 때 소프트웨어로 다시 하는 경로. 하드웨어 오류를 일으킬 방법이 없습니다.
- 실제 카메라, 휴대폰, 화면 녹화 파일. 입력은 모두 손으로 만든 바이트와 testsrc입니다.
- 내보낸 파일을 Chromium 밖(Windows 미디어 플레이어, 휴대폰)에서 재생하는 것.
- AAC 지연이 0이 아닌 경우. 이 PC에서는 0 샘플로 재었습니다.
- 앱 안에서 큰 MKV를 IPC로 색인하는 속도. 작은 블록의 WebM은 통째로 읽습니다.
- 새 효과(선명하게, 글로우, 크로마 키, 필름 그레인, 글리치 등)는 손으로 만든 그림과 CPU 참조로만 확인했습니다. 실제 그린 스크린 영상의 키 품질과 4K에서 큰 반경(글로우, 선명하게)의 재생 속도는 재지 않았습니다.
- CI 크기(`PYIDE_TEST_VIEWPORT=1024x720`)에서의 `verify/cut-timeline.mjs`의 끌어 놓기 절과 `verify/cut-panels.mjs`의 범위 마커 끝 끌기, 마커·키프레임 메뉴, 피크 유지. 이 작업 전 코드에서도 1024 px에서 같은 검사가 실패했습니다(타임라인이 좁아 100 px/s의 시간이 화면 밖). Premiere 배치에서는 도구 패널과 오디오 미터가 타임라인 옆에 있어 1024 px에서 타임라인이 더 좁습니다(레인 약 480 px). `cut-timeline`은 좁은 창에서 분할선을 옮겨 타임라인을 넓히고, `cut-tools`의 끌어 놓기는 놓을 시간이 보이게 스크롤합니다.
- 실제 Whisper 모델은 합성한 음성(Windows SAPI, 한국어 약 4분과 영어 약 35초)에 잡음, 험, 웅성거림, 음악, 잔향을 섞은 11조건 벤치마크로만 쟀습니다. 앱의 창 나누기와 합치기, 단어 시간 좁히기를 그대로 거친 글자 정확도는 large-v3-turbo 93.9%, small 88.5%이고, 단어 시작 시간 중앙값 차이는 0.035~0.07초입니다. 이 PC(Ryzen 7 4800H, 8코어)에서 소리 1분에 turbo는 약 140~180초, small은 약 45~50초 걸립니다. 한국어 백색 잡음 5 dB 이하(turbo 69~86%)는 아직 95%에 못 미칩니다. 실제 녹음, 실제 내려받기와 환경 설치(이 PC에는 이미 있음)는 확인하지 못했습니다. 벤치마크와 결정 기록은 저장소 밖에 있습니다.
- 화자 구분은 합성한 대화(Windows SAPI, 한국어와 영어, 화자 2명과 3명, 깨끗한 것과 백색 잡음 20 dB 또는 합성 음악 12 dB를 섞은 것, 8가지)로만 쟀습니다. 이 PC에는 언어마다 목소리가 하나(Heami, Zira)라서 화자는 그 목소리를 1.2배 빠르게, 0.84배 느리게 바꾼 것입니다. 앱과 같은 창 나누기와 Whisper small의 단어 시간으로 자동이 화자 수를 8개 모두 맞혔고, 단어의 99.1~100%, 말한 시간의 98.4~100%가 맞는 화자였습니다. 겹쳐 말하기가 없고 차례가 깔끔하며 방과 음량이 같아서 실제 사람보다 쉬운 조건이므로 이 숫자는 상한입니다. 자동 기준값도 같은 8가지로 정했습니다(영어만으로 정해도 한국어에 맞았습니다). 임베딩은 소리 1분에 약 0.6초(중앙값, 0.49~0.83초)입니다.
- 불확실한 단어 표시와 단어 목록도 같은 합성 음성 벤치마크로만 쟀습니다. 확신도 0.5 아래 단어는 3분의 2가 틀렸고 틀린 단어의 57%를 잡았습니다(깨끗한 소리에서는 421단어 중 1개 표시). 음악 위의 환각은 확신에 차 있어 거의 표시되지 않습니다. 단어 목록은 한국어 잡음 조건에서 0.9~1.5점 올렸고 깨끗한 소리는 그대로였지만, 영어 음악 도입부 파일은 말이 끝난 뒤 잡음에 지어낸 문장 하나로 5.7점 떨어졌습니다. 실제 녹음에서는 확인하지 못했습니다.
- 테스트에 없는 기능: 타임라인의 자막 항목 이동과 트림, 전환 길이 끌기, 효과 순서 바꾸기, 회전 손잡이, 트랙 높이와 트랙 메뉴, 정지 프레임(Shift+F), 텍스트 스타일과 글꼴 바꾸기, 효과 즐겨찾기, 떨군 프레임 표시, 유튜브 챕터 복사, 라우드니스 측정 버튼, 2-up 트림 화면.

알고 있는 한계:

- 내보내기의 라우드니스 목표는 내보낼 때마다 다시 측정해 적용합니다. 자동화의 음량 맞추기로 정한 `masterGain`에 더해집니다.
- 자동화: 자동 색의 색온도와 색조는 한쪽으로 한 스톱까지라 강한 색 틀어짐은 일부만 고칩니다. 장면 전환은 색 분포만 보아서 같은 색의 장면끼리 바뀌는 곳이나 빠른 카메라 이동은 놓치거나 잘못 잡을 수 있습니다. 박자 감지는 클릭 트랙(합성)으로만 확인했고 실제 음악으로는 확인하지 못했습니다.
- Ogg 파일과 FLAC 파일은 읽지 못해서 main이 받지 않고 가져오기 대화상자에도 나오지 않습니다. FLAC, Opus, Vorbis는 MP4와 MKV/WebM 안에 있을 때만 읽습니다.
- 오디오 미터 패널은 메인 출력만 보여 줍니다. 트랙마다의 미터는 오디오 트랙 믹서에 있습니다(`meters().trackChannels`, 페이더와 팬 뒤). -1 dBTP 선은 표시이고, 미터의 값은 오버샘플링한 실제 피크가 아니라 샘플 피크입니다.
- 오디오 효과는 클립에만 넣습니다. 트랙과 마스터의 효과 삽입, 센드와 서브믹스, 믹서 자동화 기록(쓰기, 터치)은 없습니다. 이퀄라이저 그래프는 보기만 하고 점을 끌 수 없습니다. 리미터의 트루 피크는 16탭 4배 보간이라 BS.1770의 측정보다 0.3 dB까지 넘을 수 있습니다. 기억이 4초보다 긴 설정(릴리스 약 0.7초 넘는 컴프레서 등)은 구간마다 상태를 4초 앞에서 새로 시작해서, 큰 소리 뒤 긴 릴리스 중에는 끊김 없이 이어 돌린 결과와 조금 다릅니다(시험에서 -59 dB).
- 패널 도킹은 창 메뉴로 작업 영역의 `dock` 칸에 탭을 더하는 것뿐입니다. 패널을 끌어 다른 칸으로 옮기거나 떼어 띄우지는 못합니다. 그래서 "이 작업 영역에 변경 사항 저장"이 남기는 것도 분할선과 더한 패널뿐이고, 새 작업 영역으로 저장하거나 작업 영역을 편집하지는 못합니다.
- 조금씩 옮기기는 누를 때마다 한 단계입니다. 기록에 이어진 단계를 합치는 기능이 없습니다.
- 중첩 시퀀스: 시퀀스는 언제나 중첩 클립으로 들어갑니다(Premiere의 "시퀀스를 중첩 또는 개별 클립으로 삽입 및 덮어쓰기" 전환이 없음). 중첩 클립에는 썸네일이 없고, 프레임 일치(F)와 프레임 고정 세그먼트 삽입(Shift+F)은 중첩 클립에서 동작하지 않으며, 중첩된 시퀀스의 자막은 바깥에 그려지지 않습니다. 중첩된 시퀀스 안의 미디어가 오프라인이었다가 돌아오면, 그 사이 읽은 소리 블록(무음)은 시퀀스를 고칠 때까지 남습니다.
- 시간 다시 매핑: 광학 흐름(Optical Flow)과 소리 다시 매핑은 없습니다(Premiere도 소리는 다시 매핑하지 않음). 속도 전환은 직선(속도가 시간에 비례)이고 Premiere의 베지어 손잡이로 모양을 바꾸지 못합니다. 효과 컨트롤 레인에서 키를 끌 수 없고(타임라인 줄에서 끕니다), 프레임 고정 옵션이 없습니다. 역방향 구간은 역재생 클립처럼 키 프레임 바로 앞 프레임부터 보여 주어 돌아서는 곳의 프레임이 두 번 보입니다. 프레임 혼합은 일정한 프레임률의 미디어 클립에만 하고, 실제 촬영 영상으로는 확인하지 못했습니다(testsrc만).
- 마스크: 마스크 추적(앞으로·뒤로 추적)이 없습니다. 마스크 이름 바꾸기, 여러 꼭짓점을 Shift로 골라 함께 옮기기, Premiere의 Shift 끌기 제한도 없습니다. 가장자리 늘리기 효과는 마스크를 받지 않습니다(배치할 때 가장자리를 늘일 뿐이라 그림 안에서 제한할 것이 없음). Canvas 2D 대체 경로의 페더는 가우스 흐림(시그마 = 페더 / 3.76, 가장자리에서 같은 기울기)으로 근사하고 sRGB 값에서 섞으며, 딱딱한 가장자리는 캔버스의 면적 안티에일리어싱이라 가장자리 픽셀이 다릅니다. 덮임은 픽셀마다 모든 선분까지의 거리라서 꼭짓점이 아주 많은 마스크(256개 한도, 곡선 하나에 16선분)는 4K에서 느릴 수 있고, 속도는 재지 않았습니다. 실제 촬영 영상으로는 확인하지 못했습니다(testsrc와 손으로 만든 그림만).
- 펜은 클립의 키프레임 줄(영상은 불투명도나 시간 다시 매핑 > 속도, 소리는 볼륨)에만 찍습니다. 덕킹 곡선(`duck`)과 효과 매개변수는 효과 컨트롤에서 찍습니다. 편집점은 고를 수 없어서 편집점 늘이기(E)는 고른 클립의 가까운 끝, 없으면 대상 트랙의 가장 가까운 편집점을 씁니다.
- 시작 화면에서 고르면 내장 GPU를 씁니다(1절).
- 프레임 메모리 한도는 설정값(1.5 GB)입니다. VRAM의 50%가 아닙니다.
- Canvas 2D 대체 경로의 색, 비네트, 와이프, 가장자리 늘리기는 근사입니다(4절).
- Lumetri 색상: Canvas 2D 대체 경로는 기본 교정만 CSS filter로 그리고 LUT, 커브, HSL 보조는 그리지 않습니다(스코프는 2D에서도 CPU로 셉니다). Premiere의 색상 휠과 일치, Hue/Saturation 커브(색조 대 채도 등), HSL 보조의 노이즈 제거·흐림과 색상 휠, 비네트를 같은 효과에 두는 것은 없습니다(비네트는 따로 `vignette` 효과). LUT는 3D `.cube`만 읽고(1D, `.3dl`, `.look`는 거부), 65점이 한도입니다. 65점 LUT는 프로젝트를 약 4.4 MB 키웁니다. 실제 촬영 영상과 상용 LUT로는 확인하지 못했고, 손으로 만든 그림과 LUT로만 GPU와 CPU 참조를 비교했습니다.
- Lumetri 스코프는 프로그램 모니터가 그린 크기(재생 해상도 1/2이면 그 크기)의 8비트 sRGB 출력을 셉니다. Premiere처럼 원본 해상도나 32비트 부동소수점 값을 세지 않고, 0~255 밖(슈퍼 화이트)은 보이지 않습니다. 모니터에 그린 자막과 안전 여백 선도 들어갑니다. 벡터스코프는 Rec. 709 Cb/Cr 각도라 Rec. 601 기준의 목표 각도(빨강 103°, 노랑 167°)와 조금 다릅니다(빨강 102.9°, 노랑 174.8°).
- WebGPU 장치 손실은 `compositor.lost`로 알리기만 하고 복구하지 않습니다. 호출한 쪽이 새 compositor를 만들어야 합니다.
- `decodeAudio`는 트랙 전체를 메모리에 둡니다(스테레오 한 시간에 약 1.4 GB, LRU 1.5 GB).
- AAC 인코더의 마지막 패딩 때문에 내보낸 소리가 영상보다 최대 약 20 ms 깁니다.
- 저장 안 한 프로젝트의 닫기 확인은 `beforeunload`에 기댑니다. Electron은 사용자 입력이 있었던 페이지에서만 닫기를 막습니다. `editors.js`의 `window:confirmClose`에 연결하는 고리가 없습니다.
- 네트워크 공유의 미디어는 거부합니다. 필요하면 사용자가 대화상자에서 고른 공유만 허용하는 선택이 있어야 합니다.
- `findMedia`/`listMedia`의 50,000개 한도는 시험하지 않았습니다(깊이 한도는 시험함).
- 프록시는 소리 없이 만듭니다. 프록시로 재생해도 소리는 원본에서 나옵니다. 프록시 파일이 지워진 것은 2초마다 확인하므로, 그 사이에는 이미 읽어 둔 프록시를 그립니다. 프록시는 그 프로젝트가 열려 있을 때만 미디어에 붙고, 캐시에 남은 같은 파일은 다음에 만들 때 바로 씁니다.
- 가져올 때 권하는 조건(4K 이상, HEVC, 키프레임 간격 2초 초과)은 테스트 영상으로만 확인했습니다. 실제 휴대폰 영상으로는 확인하지 못했습니다.
- 내보내기 대기열은 앱 안에만 있습니다. 앱을 닫으면(닫기 전에 묻습니다) 남은 작업은 사라집니다.
- 음성 인식: Whisper는 머뭇거리는 말(음, 어)을 받아쓰지 않을 때가 많아 군말 삭제는 받아쓴 것만 찾습니다(긴 쉼은 그와 상관없이 찾습니다). 언어는 자동, 한국어, 영어만 고릅니다. 겹쳐 놓은 두 클립이 같은 말을 하면 한 번만 보이지만, 다른 말을 동시에 하면 둘 다 보입니다. 대본은 모델과 언어마다 따로 캐시되어 설정을 바꾸면 다시 인식합니다. 인식 속도는 CPU에 달려 있습니다(GPU를 쓰지 않음).
- 화자 구분: 겹쳐 말하는 곳은 한 사람으로만 표시합니다(겹침 감지가 없음). 화자 수는 10명까지이고, 자동 기준값은 SAPI 합성 음성 벤치마크로만 정해서 실제 사람(목소리가 비슷한 두 사람, 전화 음질, 먼 마이크)에서는 화자 수를 틀릴 수 있습니다. 그럴 때는 화자 수를 정해 다시 구분합니다. Claude 번역이 만든 새 자막 트랙에는 화자가 없습니다. 1초보다 짧은 말 바꿈이 쉼 없이 이어지면 앞뒤 화자로 고릅니다.
- 음성 분리: 앱 테스트는 가짜 백엔드(소리를 그대로 보컬로)로 하고, 실제 HTDemucs는 10초 testsrc(삑 소리가 거의 지워짐)와 벤치마크의 합성 음성으로만 확인했습니다. 실제 녹음, 실제 음악 위의 말, 실제 내려받기와 패키지 설치(이 PC에는 이미 있음)는 확인하지 못했습니다. 이 PC에서 소리 1분에 약 25초(CPU 약 200초) 걸리고 모델을 읽는 데 약 5초 걸립니다. 보컬은 44.1 kHz 16비트 WAV라 한 시간에 약 635 MB입니다. 음성 인식 전 분리는 백색·분홍 잡음에서 인식을 떨어뜨려 기본값이 끔입니다(pitfalls). 5.1 같은 3채널 이상은 두 채널로 접습니다.
- Claude 텍스트 AI: 테스트는 모두 가짜 CLI로 했습니다. 실제 Claude(Haiku, Sonnet, Opus)의 답 품질(맞춤법, 번역, 챕터, 하이라이트 선택, 명령 해석)과 실제 응답 시간은 확인하지 않았습니다. 편집 명령은 허용 목록의 아홉 가지 작업만 하고(효과, 전환, 색, 속도, 클립 이동은 못 함), 계획의 시간은 적용 전 타임라인 기준입니다. 일본어와 중국어 줄 나누기는 글자 단위라 단어 중간에서 줄이 바뀔 수 있습니다(닫는 문장 부호만 앞 줄에 붙임). 쇼츠 시퀀스는 화면을 가운데에 맞추기만 하고 사람이나 얼굴을 따라가지 않습니다.
- 단축키 편집은 한 번 누르는 키만 기록합니다(Ctrl+K, C 같은 두 번 누르는 키는 IDE 키맵에서만). 단축키는 설정 `cut.keys`에 있고 Code의 키맵 "모두 재설정"과는 따로입니다. 사전 설정은 둘(Premiere Pro, 이전 키)이고 사람이 이름 붙인 사전 설정을 만들지는 못합니다.
- Premiere 키에서 Ctrl+Shift+A는 타임라인과 프로그램 모니터에 키보드가 있을 때 모두 선택 해제입니다. 그때 Find Action은 도움말 > 액션 찾기…로 엽니다(다른 패널에서는 Ctrl+Shift+A 그대로).

[2]/[3]으로 남긴 자리(만들지 않음):

- 형식: MP4 챕터 상자(`finish({chapters})`는 받고 무시), mp4write의 vp09/av01, Opus pre-skip 편집 목록, MKV 회전(ProjectionPoseRoll), AV1 시퀀스 헤더의 색 정보, 조각 MP4 안의 PCM, 가변 글꼴의 이름 있는 인스턴스, 오디오 끝 자르기.
- 편집: 해석(interpret), 트림 모드, 4점 편집 선택, Enter 렌더.
- 키프레임과 텍스트: 값·속도 그래프 보기(베지어 손잡이는 효과 컨트롤 줄에서만 끕니다), x/y 따로 크기, 여러 레이어 텍스트 편집(Add Layer 없음), 자동 줄바꿈, 테두리 여러 개.
- 엔진: 조정 레이어(그릴 때 건너뜀), 혼합 모드, HDR. 마스크 추적과 로토스코핑, AI 마스크.
- 화면: 패널 도킹(끌어 옮기기, 떼어 띄우기), 새 작업 영역으로 저장, 레이블 색.
- 내보내기: Opus/WebM, 2-pass 비트레이트, 스마트 렌더, 모노/5.1, 음높이를 유지하지 않는 속도 변경(`clip.keepPitch`).

## 8. Premiere Pro와의 비교(감사)

Premiere Pro(2024–2025, Windows 기본값)를 아는 사람이 Cut에서 다시 배우지 않도록 맞춘 것과 아직 다른 것입니다. "이전"은 이 작업 전의 Cut, "지금"은 Premiere Pro 사전 설정(새 사용자의 기본)입니다. Adobe의 상표, 아이콘, 그림은 쓰지 않습니다.

### 키보드

| Premiere Pro 기본 | 명령 | 이전 Cut | 지금 |
| --- | --- | --- | --- |
| V, A, Shift+A, B, N, R, C, Y, U, P, H, Z, T | 도구 | 같음 | 같음 |
| J, K, L, K+J/L, Space | 셔틀, 재생/정지 | 같음 | 같음 |
| I, O, X, Shift+I, Shift+O | 시작/종료 표시, 클립 표시, 이동 | 같음 | 같음 |
| / | 선택 영역 표시 | 명령 없음 | 추가 |
| Ctrl+Shift+I, Ctrl+Shift+O | 시작 지우기, 종료 지우기 | 명령 없음 | 추가 |
| Ctrl+Shift+X | 시작 및 종료 지우기 | Alt+X | Ctrl+Shift+X (이전 키에서는 Alt+X) |
| `,` `.` `;` `'` | 삽입, 덮어쓰기, 제거, 추출 | 같음 | 같음 |
| Ctrl+K, Ctrl+Shift+K | 편집 추가, 모든 트랙에 편집 추가 | 같음(둘 다 있음) | 같음 |
| Q, W | 재생 헤드까지 이전/다음 편집 잔물결 트리밍 | 같음(있음) | 같음 |
| Shift+Delete, Delete, Backspace | 잔물결 삭제, 지우기 | 같음 | 같음 |
| M | 마커 추가 | 같음 | 같음 |
| Shift+M, Ctrl+Shift+M | 다음/이전 마커로 이동 | 명령 없음 | 추가 |
| Ctrl+Alt+M, Ctrl+Alt+Shift+M | 선택한(현재) 마커 지우기, 모든 마커 지우기 | 명령 없음 | 추가(재생 헤드의 시퀀스 마커, 모두는 한 단계) |
| Ctrl+D, Ctrl+Shift+D, Shift+D | 비디오/오디오 전환 적용, 선택 영역에 기본 전환 적용 | 같음 | 같음 |
| =, -, \ | 확대, 축소, 시퀀스에 맞추기 | 같음 | 같음 |
| ↑, ↓ | 이전/다음 편집 지점(대상 트랙) | 키는 같음, 모든 트랙의 편집점 | 대상 트랙의 편집점 |
| Shift+↑, Shift+↓ | 모든 트랙에서 이전/다음 편집 지점 | 명령 없음 | 추가 |
| Shift+←/→, Alt+←/→, Alt+Shift+←/→ | 5프레임 이동, 1/5프레임 조금씩 옮기기 | 같음 | 같음 |
| Alt+↑, Alt+↓ | 클립 선택 영역을 위/아래 트랙으로 | 명령 없음 | 추가(갈 트랙이 없는 쪽은 그대로) |
| S, Ctrl+L, Ctrl+R, Ctrl+G, Ctrl+Shift+G, Shift+E, D, F, E | 스냅, 연결, 속도/지속 시간, 그룹, 해제, 사용, 재생 헤드에서 클립 선택, 프레임 일치, 편집 확장 | 같음 | 같음 |
| Ctrl+Shift+A | 모두 선택 해제 | Esc | Ctrl+Shift+A(Esc도 남김: Premiere 기본 키가 아님) |
| Ctrl+Shift+Space | 시작에서 종료까지 재생 | 단추만 | 키 추가 |
| Ctrl+Alt+N, Ctrl+O, Ctrl+S, Ctrl+Shift+S, Ctrl+I, Ctrl+M, Ctrl+Shift+E | 새 프로젝트, 열기, 저장, 다른 이름으로 저장, 가져오기, 미디어 내보내기, 프레임 내보내기 | 같음 | 같음 |
| Ctrl+Alt+S | 사본 저장 | 명령 없음 | 추가 |
| Ctrl+N, Ctrl+B | 새 시퀀스, 새 저장소(빈) | 키 없음 | 추가. Ctrl+B는 Premiere에서 저장소입니다. 중첩(Nest)은 Premiere처럼 기본 키가 없고 액션 찾기(`Cut.nest`)와 단축키 편집에 있습니다 |
| Ctrl+Alt+K | 키보드 단축키 | 키 없음 | 추가 |
| Shift+1~Shift+7 | 프로젝트, 소스, 타임라인, 프로그램, 효과 컨트롤, 오디오 트랙 믹서, 효과 패널 | 키 없음 | 추가(Shift+8 미디어 브라우저, Shift+9 오디오 클립 믹서는 패널이 없음) |
| Alt+Shift+1~6, Alt+Shift+0 | 작업 영역, 저장된 레이아웃으로 재설정 | 1~4(편집, 색, 자막, 내보내기) | 편집, 색상, 효과, 오디오, 캡션 및 그래픽, 내보내기 순서, 0은 재설정 |
| `, Shift+` | 커서 아래/활성 프레임 최대화 또는 복원 | 명령 없음 | 추가 |
| Ctrl+=, Ctrl+-, Alt+=, Alt+-, Shift+=, Shift+- | 비디오/오디오 트랙 높이, 모든 트랙 확장/최소화 | 명령 없음 | 추가(한 단계씩 실행 취소) |
| Ctrl+` | 전체 화면 | 같음 | 같음 |
| Alt+끌기, Ctrl+끌기 | 복제, 삽입 | 삽입만 | 복제 추가(놓을 때 Alt, 연결끼리 다시 연결, 한 단계) |
| Shift+R | 역방향 프레임 일치 | 없음 | 없음 |
| Ctrl+Alt+V | 특성 붙여넣기 | 없음 | 없음(효과 복사 기능이 없음) |
| Ctrl+Alt+Q/W, Shift+Q/W | 리플 없는 트리밍, 이전/다음 편집 확장 | 없음 | 없음 |
| Shift+K, Shift+Space | 주변 재생, 앞뒤 여유를 둔 재생 | 없음 | 없음 |
| Enter | 작업 영역 효과 렌더링 | 없음 | 없음(Cut은 렌더 파일을 만들지 않음) |
| Ctrl+E | 원본 편집 | 없음 | 없음 |
| (없음) | 프레임 고정 세그먼트 삽입 | Shift+F(Cut 키) | Shift+F 그대로 |

키가 같은 명령과 Cut에만 있는 명령(? 한눈에 보기, Ctrl+J 편집 명령 등)은 두 사전 설정에서 같습니다.

### 화면

| 영역 | Premiere Pro | 이전 Cut | 지금 | 아직 다른 것 |
| --- | --- | --- | --- | --- |
| 도구 패널 | 타임라인 옆의 세로 도구 패널, 묶음과 플라이아웃(누르고 있기) | 타임라인 막대의 가로 단추 13개 | 세로 도구 패널(묶음 8개, 누르고 있기·오른쪽 클릭 플라이아웃, 키 표시, 마지막 도구 기억). 가로 단추는 창 > 타임라인 도구 막대 | 사각형·타원·다각형·리믹스·세로 문자 도구가 없습니다 |
| 편집 작업 영역 | 위: 소스(효과 컨트롤 탭) 약 45%, 프로그램. 아래: 프로젝트(효과, 마커, 작업 내역 탭), 도구, 타임라인, 오디오 미터 | 오디오 미터가 위 줄 오른쪽 | Premiere 배치 | 미디어 브라우저, 라이브러리, 정보, 메타데이터, 오디오 클립 믹서 패널이 없습니다. 2025의 속성 패널이 없습니다 |
| 작업 영역 목록 | 학습, 어셈블리, 편집, 색상, 효과, 오디오, 캡션 및 그래픽 … | 편집, 색, 자막과 그래픽, 내보내기 | 편집, 색상, 효과, 오디오, 캡션 및 그래픽, 내보내기 | 학습과 어셈블리는 넣지 않았습니다(학습 콘텐츠와 미디어 브라우저가 없음). 내보내기는 Cut에만 있습니다(Premiere는 머리글의 내보내기 모드) |
| 오디오 작업 영역 | 오디오 트랙 믹서, 프로그램, 기본 사운드 | 없음 | 오디오 트랙 믹서(`mixer`)·효과 컨트롤·소스, 프로그램, 기본 사운드(`essential`), 아래는 편집과 같음 | |
| 작업 영역 재설정 | 저장된 레이아웃으로 재설정, 변경 사항 저장 | 없음(분할선은 늘 저장) | "이 작업 영역 재설정"(Alt+Shift+0)과 "이 작업 영역에 변경 사항 저장": 탭의 오른쪽 클릭 메뉴, 창 > 작업 영역 | 새 작업 영역으로 저장, 작업 영역 편집, 패널 끌어 도킹이 없습니다 |
| 넘치는 작업 영역 탭 | » 메뉴 | 잘림 | » 메뉴 | |
| 메뉴 막대 | 파일, 편집, 클립, 시퀀스, 마커, 그래픽 및 타이틀, 보기, 창, 도움말 | 없음(위 막대의 단추와 창·자동화·설정 메뉴) | 같은 아홉 메뉴, Cut의 명령을 Premiere 자리에, 키는 키맵에서. 위 막대의 빠른 단추는 그대로 | Alt+글자 니모닉이 없습니다(Electron 창이 Alt를 기본 메뉴에 씀). Cut에 없는 명령(렌더, 다중 카메라 등)은 메뉴에도 없습니다 |
| 트랙 헤더 | 소스 패치, 트랙 잠금, 트랙 타겟팅, 동기화 잠금, 트랙 출력(비디오) / 음소거, 솔로, 음성 해설 녹음(오디오) | 같은 단추가 패치, 타겟, 잠금, 동기 잠금 순 | Premiere 순서와 이름(켜기/끄기), 트랙 높이 키 | 음성 해설 녹음(녹음 기능 없음), 헤더 사용자 지정, 자막 트랙의 출력 켜기/끄기(보이는 자막 트랙은 자막 패널이 고름)가 없습니다 |
| 모니터 단추 | 마커 추가, 시작/종료 표시, 시작 표시로 이동, 1프레임 뒤로, 재생, 1프레임 앞으로, 종료 표시로 이동, 삽입·덮어쓰기(소스) 또는 제거·추출(프로그램), 프레임 내보내기, + 단추 편집기 | 시작/종료 표시, 이동, 단계, 재생, 반복, 시작에서 종료까지 재생, 삽입·덮어쓰기(소스) | Premiere 세트와 순서, 단추 편집기(반복, 시작에서 종료까지 재생, 시작·종료 지우기, 클립 표시, 편집 지점·마커 이동), 레이아웃 재설정. 타임코드·확대·해상도·길이 줄 아래에 시간 막대, 그 아래 단추 | 소스 모니터의 마커 추가(미디어 파일 마커가 없음), 비교 보기, 다중 카메라. 단추 편집기는 끌어 놓기가 아니라 체크 목록입니다 |
| 클립 메뉴 | 잘라내기, 복사, 특성 붙여넣기, 지우기, 잔물결 삭제 / 사용, 연결 해제, 그룹 / 레이블 / 속도/지속 시간 / 프레임 고정 / 이름 바꾸기, 프로젝트에서 보기 … | 같은 명령, 레이블이 아래, "프레임 고정 추가"(실제로는 세그먼트 삽입) | Premiere 순서, "프레임 고정 세그먼트 삽입", 중첩…, 키는 키맵에서 | 특성 붙여넣기/제거, 오디오 게인, 프레임 크기로 비율 조정, 프로젝트에서 보기, 속성이 없습니다 |
| 시간 다시 매핑 | 효과 컨트롤의 시간 다시 매핑 > 속도(스톱워치, 키프레임). 클립의 fx 배지 > 시간 다시 매핑 > 속도로 줄에 속도를 보임. Ctrl+클릭(또는 펜)으로 속도 키프레임, 줄을 위아래로 끌어 구간 속도(툴팁), 키프레임 반쪽을 끌어 속도 전환, Alt 끌기로 옮기기, Ctrl 끌기로 역방향, Ctrl+Alt 끌기로 정지. 클립 길이가 바뀌지만 뒤 클립을 밀지 않고 다음 클립까지만 늘어남. 오디오는 그대로. 클립 > 비디오 옵션 > 시간 보간(프레임 샘플링, 프레임 혼합, 광학 흐름) | 속도/지속 시간만(일정한 속도, 역방향, 속도 조정 도구) | 같은 효과 컨트롤 줄과 타임라인 줄의 동작(fx 배지, 클립 메뉴의 클립 키프레임 표시, 로그 눈금, 툴팁에 속도와 새 길이, 탭 끌기는 키의 프레임을 지키고 앞 구간 속도를 바꿈, 역방향은 빨강, 정지는 파랑), 한 단계 실행 취소, 길이는 다음 클립까지만(나머지는 클립 끝 뒤에 숨음), 연결 오디오 그대로, 자르기·트림·슬립·붙여넣기가 곡선을 따라감, 속도/지속 시간과 속도 조정 도구는 거부, 시간 보간의 프레임 샘플링·프레임 혼합(클립 메뉴와 클립 > 비디오 옵션), 중첩 클립에도 | 광학 흐름, 속도 전환의 베지어 손잡이, 효과 컨트롤 레인에서 키 끌기, 프레임 고정 옵션 |
| 중첩(Nest) | 클립 > 중첩…: 이름 대화상자("중첩된 시퀀스 01"), 고른 클립이 새 시퀀스로 들어가고 가장 낮은 트랙에 중첩 클립 하나. 시퀀스를 타임라인에 끌거나 소스 모니터에서 삽입·덮어쓰기하면 중첩 클립(설정으로 개별 클립도 가능). 두 번 클릭하면 그 시퀀스가 타임라인 탭으로 열림. 중첩 클립은 시퀀스 레이블 색 | 없음(시퀀스 놓기는 안내와 함께 거부) | 클립 > 중첩…, 클립 메뉴, 액션 찾기(`Cut.nest`). 이름 대화상자("중첩된 시퀀스 1"), 한 단계, 트랙 자리와 시간, 전환·키프레임·효과·링크가 따라감, 가장 낮은 비디오·오디오 트랙에 링크된 중첩 클립. 프로젝트 패널에서 끌기, 소스 모니터에서 열기와 삽입·덮어쓰기, 두 번 클릭으로 탭과 같은 프레임. 초록(Forest) 색과 두 겹 표시, 시퀀스 이름. 그림과 소리 모두 그 시퀀스를 원본으로 쓰고 중첩 클립의 모션·불투명도·효과·볼륨·팬이 위에 얹힘. 자기 안에 중첩은 한국어 안내와 함께 거부. 중첩된 시퀀스 삭제는 쓰인 곳을 말하고 물음 | 시퀀스를 개별 클립으로 넣는 설정, 중첩 클립의 썸네일, 중첩 클립에서 프레임 일치와 프레임 고정, 이름 뒤의 두 자리 번호("01"이 아니라 "1") |
| 마스크 | 불투명도와 모든 비디오 효과의 타원 마스크 만들기, 4포인트 다각형 마스크 만들기, 자유 그리기 베지어. 마스크마다 마스크 패스(키프레임, 앞으로·뒤로 추적), 마스크 페더(10), 마스크 불투명도(100%), 마스크 확장(0), 반전됨. 프로그램 모니터에서 마스크 끌기, 꼭짓점 끌기, 핸들, Alt+클릭으로 모서리↔부드러움, Ctrl+클릭으로 꼭짓점 삭제, Ctrl+클릭(선분)으로 꼭짓점 추가([도움말](https://helpx.adobe.com/no/premiere/desktop/add-video-effects/create-masks-and-composites/modifiers-and-conditions-for-masking.html)), 페더·확장 손잡이와 안내선. 효과의 마스크는 그 효과를 영역에 한정 | 없음 | 같은 세 단추와 다섯 속성(그리고 마스크 모드: 더하기, 빼기, 교차, 차이, 없음), 같은 모니터 동작(선분은 그냥 클릭으로도 추가), 끌기마다 한 단계, 마스크 패스 키프레임(꼭짓점 수가 같으면 꼭짓점마다 보간, 다르면 유지), 모든 비디오 효과(가장자리 늘리기 제외)와 Lumetri 색상, 클립 모션을 따라감, 중첩·시간 다시 매핑된 클립, WebGPU와 Canvas 2D, 모니터와 같은 내보내기, 형식 버전 4 | 마스크 추적, 마스크 이름 바꾸기, 여러 꼭짓점 선택, 가장자리 늘리기의 마스크 |
| 타임라인·눈금자·트랙·프로젝트 메뉴 | 빈 곳: 잔물결 삭제, 붙여넣기 / 트랙: 이름 바꾸기, 트랙 추가·삭제 / 프로젝트: 새 저장소, 새 항목 … | 비슷한 항목 | 눈금자 메뉴의 키가 키맵을 따름 | 프로젝트 패널 메뉴는 그대로(`ui-project.js`) |
| 키보드 사전 설정 | 키보드 레이아웃 사전 설정(Adobe Premiere Pro 기본값 등) | 하나 | Adobe Premiere Pro(새 사용자 기본), Nano Studio Cut(이전 키) | 이름 붙인 사용자 사전 설정, 키보드 그림 보기가 없습니다 |

### 용어(한국어)

Premiere Pro 한국어판의 이름으로 쓴 것(새 기능): 마스크, 마스크 패스, 마스크 페더, 마스크 불투명도, 마스크 확장, 반전됨, 타원 마스크 만들기, 4포인트 다각형 마스크 만들기, 자유 그리기 베지어, 시간 다시 매핑, 속도, 속도 전환, 클립 키프레임 표시, 시간 보간, 프레임 샘플링, 프레임 혼합. Premiere Pro 한국어판의 이름으로 바꾼 것: 잔물결 삭제(리플 삭제), 잔물결 편집 도구, 롤링 편집 도구(롤), 속도 조정 도구(속도 늘이기), 밀어넣기 도구(슬립), 밀기 도구(슬라이드), 제거(들어올리기), 추출(뽑아내기), 재생 헤드까지 이전/다음 편집 잔물결 트리밍, 재생 헤드에서 클립 선택, 선택한 편집을 재생 헤드까지 확장, 중첩, 중첩된 시퀀스, 이전/다음 편집 지점으로 이동, 속도/지속 시간(속도/길이), 타임라인에서 스냅(붙기), 동기화 잠금(동기 잠금), 왼쪽/오른쪽으로 셔틀, 작업 영역(작업 공간), 캡션 및 그래픽(자막과 그래픽), 저장소(빈), 키보드 단축키(단축키). 이미 같던 것: 효과 컨트롤, 프로그램, 소스, 프로젝트, 시퀀스, 편집 추가, 모든 트랙에 편집 추가, 마커 추가, 시작/종료 표시, 삽입, 덮어쓰기, 프레임 일치, 작업 내역, 오디오 미터, 오디오 트랙 믹서. 패널과 설명 문장의 "자막", "재생 위치"는 Cut의 다른 화면과 같게 두었습니다(Premiere는 "캡션", "재생 헤드"). 영어도 Premiere 이름으로 바꾼 명령: Insert Frame Hold Segment, Apply Default Transitions to Selection, Snap in Timeline, Toggle Track Lock/Sync Lock/Track Output/Track Targeting.
