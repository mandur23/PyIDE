# Nano Studio Cut 개발 가이드

Nano Studio Cut(영상 편집 앱)을 고칠 때 보는 문서입니다. 공통 구조와 작업 순서는 [development.md](development.md), 이 앱에서 겪은 문제는 [pitfalls.md](pitfalls.md)의 "공통"과 "Cut" 절에 있습니다. 모듈마다의 API는 [cut-architecture.md](cut-architecture.md)(영어)에, 사용자에게 보이는 기능 요약은 [FEATURES.md](../FEATURES.md)의 "Video editor" 절에 있습니다.

설계 문서:

- [video-editor-plan.md](video-editor-plan.md): 앱을 만들기로 한 계획과 결정
- [video-editor-features.md](video-editor-features.md): 기능 설계. 기능마다 [1](첫 출시), [2](프로 편집), [3](고급) 표시가 있습니다. 지금은 [1]만 만들었습니다.

## 1. 실행

```bash
npm start -- --mode=cut
```

- 시작 화면에서는 세 번째 카드(`#chooseCut`, "영상 편집")를 누릅니다.
- 작업 폴더는 `%USERPROFILE%\Nano Studio Cut`입니다. main.js가 만들고, 신뢰하고, 프로젝트(`ide.root`)로 엽니다. 안에 `Projects`(프로젝트 기본 위치), `Autosave`(자동 저장과 `.sessions` 세션 표시), `Cache`(썸네일, 파형, 프록시)가 있습니다. 내보내기 저널은 `<userData>\cut-exports`에 있습니다.
- 테스트와 실험은 `PYIDE_CUT_HOME`으로 다른 폴더를 줍니다. 안 주면 사용자의 실제 프로젝트와 자동 저장이 열립니다.
- Cut에서 로드되는 플러그인은 필수 플러그인(diagnostics, notifications, problems, project-roots, run, settings, terminal)과 updater, cut입니다. Code와 Craft의 플러그인은 없습니다.
- 시작 화면에서 Cut을 고르면 기본(내장) GPU 어댑터를 씁니다. 모드는 app ready 뒤에 정해져서 `force_high_performance_gpu` 스위치를 줄 수 없습니다. 이 PC에서는 AMD 내장 GPU가 잡힙니다. compositor는 `powerPreference: 'high-performance'`로 요청하지만, 어댑터는 그대로입니다.

## 2. 화면 구조

- `body.app-cut`가 켜지고 CSS가 IDE의 툴바, 스트라이프, 프로젝트 패널, 편집기 영역, 아래 툴 윈도우를 숨깁니다. `#cutHost`가 상태 표시줄 위의 창 전체를 채웁니다.
- 작업 폴더가 열리면 `ide.emit('cutReady', {host})`가 옵니다. `index.js`가 스크립트를 모두 로드한 뒤 `Cut.app`을 만들고 `Cut.ui.start(host, app)`를 부릅니다. 끝나면 `window.__cutReady = true`입니다.
- 위 막대: 프로젝트 이름, 새로 만들기/열기/저장/다른 이름으로 저장, 실행 취소/다시 실행, 작업 공간 탭, 내보내기.
- 작업 공간은 넷입니다. 편집(소스, 효과 컨트롤, 프로그램, 프로젝트, 효과, 타임라인), 색(프로그램, 색, 효과 컨트롤, 타임라인), 자막과 그래픽(자막, 프로그램, 텍스트), 내보내기(내보내기 패널, 프로그램, 타임라인). 칸마다 패널이 탭으로 있고, 칸 크기는 저장됩니다. 패널은 한 번만 만들고 작업 공간 사이에서 옮깁니다.
- 키는 마지막으로 누른 패널(`app.focusPanel`)로 갑니다. 입력칸이나 텍스트 레이어에 쓰는 중에는 단축키가 동작하지 않습니다.
- 설정 창에는 `craft: true`인 페이지만 나옵니다. Cut은 아직 설정 페이지가 없습니다.
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
| `model.js` | 프로젝트 모양, `validate`, `migrate`, `clipDuration`, `sourceTime` 같은 시간 계산 |
| `keyframes.js` | 키프레임 값과 이징 |
| `commands.js` | 편집 명령과 실행 취소 기록(`createHistory`) |
| `srt.js` | SRT/VTT 읽기와 쓰기, 인코딩 판별(UTF-8, UTF-16, CP949) |
| `effects.js` | 효과와 전환 레지스트리: 매개변수, WGSL, CPU 참조, Canvas 2D 힌트 |
| `textrender.js` | 텍스트 레이어와 자막 그리기, 모션 프리셋(페이드, 올라오기, 타자기) |
| `media.js` | IPC 리더, 미디어 열기와 가져오기, 디코더 설정 |
| `decoder.js` | VideoDecoder 프레임 소스와 프레임 캐시, 오디오 트랙 디코딩 |
| `compositor.js` | 시퀀스 프레임 합성(WebGPU, 없으면 Canvas 2D) |
| `player.js` | 재생, 탐색, J/K/L 셔틀, 떨군 프레임 세기 |
| `thumbs.js` | 썸네일 띠와 파형 피크(`cut:cache*`에 캐시) |
| `presets.js` | 내보내기·시퀀스 프리셋, H.264/HEVC 레벨, 크기와 시간 추정 |
| `audioengine.js` | 믹서, 미리 듣기, 오프라인 렌더, 라우드니스 측정 |
| `export.js` | 내보내기(인코딩, 먹싱, faststart, 검증), 프레임 PNG, 유튜브 챕터 |
| `testsrc.js` | 테스트 미디어: 프레임 번호 블록, 1 kHz 삑 소리, 흰 번쩍임 |
| `ui-base.js` | `Cut.ui`의 바탕: 패널과 액션 등록, 패널 사이 끌어 놓기, 공용 위젯 |
| `ui-shell.js` | 위 막대, 작업 공간, 새로 만들기/열기/저장, 자동 저장, 복구, 닫기 확인 |
| `ui-project.js` | 프로젝트 패널: 가져오기, 빈, 목록과 썸네일 보기, 오프라인과 다시 연결, 새 시퀀스 |
| `ui-monitors.js` | 소스와 프로그램 모니터 |
| `ui-export.js` | 내보내기 대화상자와 패널, 프레임 내보내기, 챕터 복사 |
| `ui-captions.js` | 자막 패널, SRT 가져오기와 내보내기, 자막 스타일 |
| `ui-keys.js` | 단축키(IDE 액션 `Cut.<id>`)와 기본 편집 동작 |
| `ui-timeline.js` | 타임라인(트랙 헤더, 눈금자, 클립, 전환, 도구, 끌기와 트림), `Cut.ui.edit`, `Cut.ui.timeline` |
| `ui-controls.js` | 효과 컨트롤: 속성, 효과 매개변수, 키프레임 줄 |
| `ui-effects.js` | 효과 패널: 분류, 검색, 즐겨찾기, 기본 전환 |
| `ui-text.js` | 텍스트 패널: 레이어, 글꼴, 스타일, 저장한 텍스트 스타일, 모션 프리셋 |
| `ui-color.js` | 색 패널: 기본 보정(`color.basic`), 비네트, 화이트 밸런스 스포이트 |
| `ui-overlay.js` | 프로그램 모니터 위의 이동, 크기, 회전 손잡이와 제자리 텍스트 편집 |
| `style.css`, `css/shell.css`, `css/timeline.css`, `css/panels.css` | 토큰과 영역별 모양 |
| `locales/ko.json` | 한국어 |

### 메인

| 파일 | 맡은 일 |
| --- | --- |
| `main.js` | `--mode=cut`, `cutHome()`(`PYIDE_CUT_HOME`), 작업 폴더 만들기와 신뢰 |
| `main/windows.js`, `main/plugin-manager.js` | 창 제목, 시작 화면의 `cut` 선택, 플러그인 모드 `cut` |
| `main/features/cut.js` | `cut:*` IPC 등록, 폴더, 대화상자(`PYIDE_CUT_DIALOG`), 읽기 |
| `main/cut/paths.js` | 경로 검사(로컬 일반 파일, realpath, 네트워크 경로 거부)와 확장자 목록 |
| `main/cut/limits.js` | 채널마다의 크기 한도(읽기 64 MB, 쓰기 256 MB 등) |
| `main/cut/project.js` | `.ncut` 읽기와 원자적 쓰기, `.bak`, 자동 저장, 세션 표시, 복구 목록 |
| `main/cut/sink.js` | 내보내기 파일 sink(`.part`에 쓰고 이름 바꾸기), 남은 조각 정리 저널 |
| `main/cut/faststart.js` | moov를 mdat 앞으로 옮기고 청크 오프셋 고치기 |
| `main/cut/cache.js` | 앱 전체 캐시와 LRU 정리(`cut.cacheLimitGB`, 기본 10) |
| `main/cut/find.js` | 다시 연결할 파일 찾기(`findMedia`)와 폴더 가져오기 목록(`listMedia`) |
| `main/cut/fonts.js` | 설치된 글꼴 목록(한국어 이름 포함)과 TTC 한 면을 떼어 낸 글꼴 데이터 |
| `main/cut/runs.js` | 표시를 쓴 실행이 아직 살아 있는지 판단 |

### 코어에서 Cut에 닿는 곳

`renderer/core/ide.js`(`ide.appMode === 'cut'`, `body.app-cut`, `cutReady`), `renderer/core/styles.css`(`#cutHost`), `renderer/index.html`(`#cutHost`), `renderer/chooser.html`과 `renderer/core/chooser.js`(Cut 카드), `renderer/features/settings/index.js`(`craft: true` 페이지만), `renderer/features/updater/plugin.json`(모드에 `cut`).

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
- `Sequence.masterGain`(dB, 기본 0)은 `setSequence`로 바꾸고, 믹서가 미리 듣기와 내보내기에 함께 적용합니다.

### 엔진 (effects, textrender, media, decoder, compositor, player, thumbs)

- 디코더가 내준 VideoFrame은 빌린 것입니다. 쓴 뒤 `release(frame)`합니다. `decoder.stats().open`으로 남은 프레임을 셉니다.
- 하드웨어 VideoDecoder를 직접 쓸 때는 프레임을 output 콜백 안에서 그리고 닫습니다. 출력 프레임을 쥐고 있으면 디코더가 멈추고 `flush()`가 끝나지 않습니다.
- 프리페치는 디코더 안에 남은 프레임까지 세고 한 장씩 넣습니다. 안 그러면 캐시가 넘쳐 곧 보여 줄 프레임을 버립니다.
- `importExternalTexture(VideoFrame)`는 그 task가 끝나면 만료됩니다. 가져온 뒤 submit까지 await 없이 하고, 프레임은 `idle()`(onSubmittedWorkDone) 뒤에 반납합니다. compositor를 없애기 전에 `idle()`을 기다립니다.
- WebGPU의 layout `'auto'`는 셰이더가 읽지 않는 binding을 뺍니다. 모든 binding을 씁니다.
- 색 공식은 `effects.js` 한 곳에만 둡니다. UI는 `Cut.effects.whiteBalance`처럼 엔진 함수를 씁니다.
- Canvas 2D 대체 경로는 근사입니다. 색은 CSS filter로 sRGB 값에서 섞고, 비네트는 원형 그라데이션, 와이프는 가장자리가 딱딱하고, 가장자리 늘리기는 그리지 않습니다. 테스트 기대값도 sRGB 평균으로 둡니다.
- 프레임 메모리 한도는 VRAM의 50%가 아니라 설정값(`decoder.setBudget`, 기본 1.5 GB)입니다. WebGPU가 VRAM 크기를 알려 주지 않습니다.
- 글꼴은 `cut:fonts`의 목록에서 고르고, TTC는 `cut:fontData(file, index)`로 받아 `new FontFace(name, data)`로 올립니다.

### 소리와 내보내기 (presets, audioengine, export, testsrc)

- 미리 듣기와 내보내기는 같은 믹서를 씁니다. 들리는 것이 내보내지는 것입니다.
- 인코더에는 GPU 캔버스의 프레임을 줍니다. Chromium 인코더는 CPU 메모리의 프레임(willReadFrequently 2D 캔버스, RGBA 버퍼)을 full range YUV로 바꿔 파일이 어둡게 풀립니다. export는 WebGPU가 아닌 compositor의 프레임을 GPU 캔버스로 옮겨 넣습니다.
- AAC 비트레이트는 128, 160, 192 kbps만 씁니다(`Cut.presets.AUDIO_BITRATES`, 기본 192). Windows의 AAC 인코더(Media Foundation)가 96/128/160/192만 받고, 오류는 configure가 아니라 encode 중에 옵니다. export는 실제 인코딩으로 확인하고 낮은 쪽으로 내려갑니다.
- 라우드니스 측정은 `Cut.audioengine.measure`(흘려 가며 측정)로 합니다. `renderOffline`은 한 시간에 약 1.4 GB를 메모리에 둡니다.
- 내보내기 파일은 `cut:writeOpen` → `cut:writeAt` → `cut:writeClose({commit})` → `cut:faststart` 순서로 씁니다. 취소나 실패하면 `.part`를 지웁니다.
- 결과 확인 문제(`verified.problems`)와 실패 문구는 영어이고, 화면에는 `tr(message, params)`로 보여 줍니다. 챕터는 `Cut.export.chapters(seq, {firstName: tr('Intro')})`로 만듭니다.
- 오류 코드는 문자열만 넘깁니다. DOMException의 숫자 `.code`가 `'9'`로 새어 나간 적이 있습니다.

### 메인 (`main/features/cut.js`, `main/cut/`)

- 렌더러가 준 경로는 `paths.js`를 지납니다. 로컬 일반 파일만, realpath로 확인하고, 확장자는 받은 이름과 실제 이름 둘 다 봅니다(8.3 이름이 다른 확장자를 숨깁니다).
- 네트워크 경로(`\\host\share`, `\\?\UNC\...`, 그런 곳을 가리키는 링크)는 아무것도 건드리기 전에 거부합니다. 열기만 해도 Windows가 NTLM으로 로그인합니다. 매핑된 드라이브 문자는 됩니다.
- 결과는 값으로 돌려줍니다(`{error, code}`). 예상되는 실패에서 던지지 않습니다.
- 쓰기는 정해진 확장자만 합니다. 프로젝트는 `.ncut`만, 내보내기는 mp4 m4a mov webm wav png jpg jpeg srt vtt txt만 씁니다.
- 대화상자 문구는 렌더러가 `tr()`로 번역해 넘깁니다(`title`, `filterName`, `allName`).

### 화면 (`ui-*.js`)

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

테스트 미디어는 `Cut.testsrc`나 테스트가 만든 바이트만 씁니다. 다운로드와 저작권이 있는 미디어는 쓰지 않습니다. 프레임 N은 숫자와 흑백 블록 줄로 N을 보여 주고(`readFrameNumber`로 읽음), 정해진 간격마다 1 kHz 삑 소리와 흰 번쩍임이 있습니다.

### 주요 테스트

| 테스트 | 종류 | 포트 | 내용 |
| --- | --- | --- | --- |
| `verify/cut-formats.mjs` | Node | - | 읽기와 쓰기 표 비교, 손으로 만든 상자들, 깨진 파일, Monaco `loader.js` 옆에서의 로드 |
| `verify/cut-model.mjs` | Node | - | 명령, 실행 취소, 무작위 2,000단계, 동기 잠금, 링크, 키프레임, SRT/VTT, migrate |
| `verify/cut-main.mjs` | Node | - | 모든 `cut:*` 채널(Electron 대역), 경로 공격, 자동 저장과 복구, sink, faststart, 캐시, 글꼴 |
| `verify/cut-engine-core.mjs` | Node | - | 효과 CPU 참조, 전환, compositor 계획, 모션 프리셋, 피크 |
| `verify/cut-export-core.mjs` | Node | - | 프리셋, 리샘플러와 WSOLA, 라우드니스, 믹서, testsrc, 내보내기의 순수 부분 |
| `verify/cut-engine.mjs` | 앱 | 9753 | 프레임 정확도, 변형, 효과, 전환, 한글 텍스트, 자막, 재생, 프레임 누수, 2D 대체 |
| `verify/cut-export.mjs` | 앱 | 9754 | 실제 인코딩과 다시 디코딩, PSNR, 소리 위치와 음높이, 하드웨어/소프트웨어/HEVC, 취소, 라우드니스 |
| `verify/cut-shell.mjs` | 앱 | 9755 | 위 막대와 작업 공간, 저장과 복구, 가져오기, 모니터, 내보내기 대화상자, 자막, 단축키 |
| `verify/cut-timeline.mjs` | 앱 | 9756 | 타임라인 동작과 키, 끌어 놓기, 효과 컨트롤, 효과와 색 패널, 오버레이와 IME, 클립 500개, 화면 캡처 |
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
- CI 크기(`PYIDE_TEST_VIEWPORT=1024x720`)에서의 `verify/cut-timeline.mjs`.
- 테스트에 없는 기능: 마커 끌기와 편집 대화상자, 타임라인의 자막 항목 이동과 트림, 전환 길이 끌기, 효과 순서 바꾸기, 회전 손잡이, 트랙 높이와 트랙 메뉴, 정지 프레임(Shift+F), 텍스트 스타일과 글꼴 바꾸기, 효과 즐겨찾기, 떨군 프레임 표시, 유튜브 챕터 복사, 라우드니스 측정 버튼, 2-up 트림 화면.

알고 있는 한계:

- 시퀀스의 `masterGain`을 화면에서 바꾸는 버튼(Match)은 없습니다. 내보내기의 라우드니스 목표는 내보낼 때마다 다시 측정해 적용합니다.
- Ogg 파일과 FLAC 파일은 읽지 못해서 main이 받지 않고 가져오기 대화상자에도 나오지 않습니다. FLAC, Opus, Vorbis는 MP4와 MKV/WebM 안에 있을 때만 읽습니다.
- 오디오 미터는 `audioengine.meters()`로 있지만 보여 주는 패널이 없습니다.
- `lift`/`extract` 명령은 있지만 화면에서 부르는 곳이 없습니다(키는 [2]).
- 시작 화면에서 고르면 내장 GPU를 씁니다(1절).
- 프레임 메모리 한도는 설정값(1.5 GB)입니다. VRAM의 50%가 아닙니다.
- Canvas 2D 대체 경로의 색, 비네트, 와이프, 가장자리 늘리기는 근사입니다(4절).
- WebGPU 장치 손실은 `compositor.lost`로 알리기만 하고 복구하지 않습니다. 호출한 쪽이 새 compositor를 만들어야 합니다.
- `decodeAudio`는 트랙 전체를 메모리에 둡니다(스테레오 한 시간에 약 1.4 GB, LRU 1.5 GB).
- AAC 인코더의 마지막 패딩 때문에 내보낸 소리가 영상보다 최대 약 20 ms 깁니다.
- 저장 안 한 프로젝트의 닫기 확인은 `beforeunload`에 기댑니다. Electron은 사용자 입력이 있었던 페이지에서만 닫기를 막습니다. `editors.js`의 `window:confirmClose`에 연결하는 고리가 없습니다.
- 자동 저장은 편집이 멈추고 2초 뒤에 하고, 키마다 20개를 남깁니다. 그래서 남는 기록은 최근 약 40초 분량입니다. 기능 설계의 "5분마다 20개"와 다릅니다.
- 프록시 만들기가 없습니다. 모니터의 프록시 스위치(`player.setProxy`)와 `setProxy` 명령만 있습니다. 프록시 파일이 없어지면 원본으로 돌아가지 않고 오프라인으로 그립니다.
- 네트워크 공유의 미디어는 거부합니다. 필요하면 사용자가 대화상자에서 고른 공유만 허용하는 선택이 있어야 합니다.
- `findMedia`/`listMedia`의 50,000개 한도는 시험하지 않았습니다(깊이 한도는 시험함).
- Cut의 설정 페이지가 없습니다. 캐시 한도(`cut.cacheLimitGB`)는 settings.json에서만 바꿉니다.

[2]/[3]으로 남긴 자리(만들지 않음):

- 형식: MP4 챕터 상자(`finish({chapters})`는 받고 무시), mp4write의 vp09/av01, Opus pre-skip 편집 목록, MKV 회전(ProjectionPoseRoll), AV1 시퀀스 헤더의 색 정보, 조각 MP4 안의 PCM, 가변 글꼴의 이름 있는 인스턴스, 오디오 끝 자르기.
- 편집: 클립 그룹(`clip.group`은 null), 해석(interpret), 중첩 시퀀스(시퀀스 놓기는 안내와 함께 거부), 슬립/슬라이드/속도 늘이기/펜 도구(`app.tool` 값만 있음), 트림 모드, 기록 패널(`history.list()`만 있음), 4점 편집 선택, 속도 램프, lift/extract 키, 삽입 붙여넣기 키(`pasteInsert` 처리기만 있음), 키보드로 조금씩 옮기기, R/Y/U/P 도구, Ctrl+G, Enter 렌더.
- 키프레임과 텍스트: hold와 bezier 이징은 데이터에만 있고 메뉴에 없음, x/y 따로 크기, 여러 레이어 텍스트 편집(Add Layer 없음), 자동 줄바꿈, 테두리 여러 개.
- 엔진: 조정 레이어(그릴 때 건너뜀), 혼합 모드, 마스크, HDR.
- 화면: 패널 도킹과 작업 공간별 배치 저장(칸 크기만 저장), 레이블 색, 쓰지 않은 미디어 고르기.
- 내보내기: Opus/WebM, 2-pass 비트레이트, 내보내기 대기열, 스마트 렌더, 모노/5.1, 음높이를 유지하지 않는 속도 변경(`clip.keepPitch`).
