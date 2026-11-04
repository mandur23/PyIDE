# 문서 안내

Nano Studio를 고칠 때 볼 문서입니다. 무엇을 하느냐에 따라 아래 순서로 읽습니다.

| 할 일 | 읽을 문서 |
| --- | --- |
| 처음 작업할 때 | [development.md](development.md): 구조, 기능 만드는 법, 코딩 규칙, 테스트, 커밋과 릴리스 |
| Code(IDE)를 고칠 때 | [code-app.md](code-app.md), 그리고 [pitfalls.md](pitfalls.md)의 "공통"과 "Code" 절 |
| Craft(마인크래프트 앱)를 고칠 때 | [craft-app.md](craft-app.md), 그리고 [pitfalls.md](pitfalls.md)의 "공통"과 "Craft" 절 |
| 기능의 정확한 동작이나 API를 찾을 때 | [FEATURES.md](../FEATURES.md): 기능 이름으로 검색 |
| 테스트를 돌리거나 고칠 때 | [development.md](development.md)의 6절, [pitfalls.md](pitfalls.md)의 테스트 절 |
| 릴리스할 때 | [development.md](development.md)의 8절, [pitfalls.md](pitfalls.md)의 "CI와 릴리스", [CHANGELOG.md](../CHANGELOG.md) |

## 문서마다 맡은 것

- [development.md](development.md): 두 앱에 공통인 개발 방법입니다.
- [code-app.md](code-app.md): Code의 코어 지도, 자주 고치는 영역, 플러그인별 메인 모듈과 테스트입니다.
- [craft-app.md](craft-app.md): Craft의 화면 구조, 파일 지도, 기능별 규칙, 테스트 대역, 하지 않는 것입니다.
- [pitfalls.md](pitfalls.md): 실제로 겪은 문제와 그때 정한 규칙입니다. 공통, Code, Craft, 도구, CI와 릴리스, 남은 문제로 나뉩니다.
- [FEATURES.md](../FEATURES.md): 기능과 API의 상세 명세입니다(영어).
- [CHANGELOG.md](../CHANGELOG.md): 버전별 변경 내역입니다. `## <버전>` 절이 릴리스 노트가 됩니다.
- 설계 문서: [nano-studio-design.md](nano-studio-design.md)(Code와 Craft 분리), [craft-players-design.md](craft-players-design.md)(플레이어 탭), [craft-private-share-design.md](craft-private-share-design.md)(비공개 공유).

## 문서를 고치는 규칙

- 기능의 동작을 바꾸면 FEATURES.md의 그 기능 절을 고칩니다.
- 새 문제를 고치면 pitfalls.md의 맞는 절에 원인과 규칙을 한 줄로 넣습니다. 아직 못 고친 문제는 "아직 남은 문제" 절에 넣습니다.
- 파일을 옮기거나 새 플러그인을 만들면 code-app.md나 craft-app.md의 지도를 고칩니다.
- 작업 순서나 릴리스 절차가 바뀌면 development.md를 고칩니다.
- CHANGELOG.md는 릴리스할 때 씁니다.
