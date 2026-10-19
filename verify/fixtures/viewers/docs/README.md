# 음성 변환 프로젝트

RVC 모델로 **목소리를 변환**하는 실험 노트입니다. 한글 문장이 깨지지 않고 보여야 합니다.

![샘플 이미지](../images/sample.png)

- [공식 문서](https://example.com/docs)
- [데이터 설명](../data/table.csv)
- [위험한 링크](javascript:alert(1))

<script>window.__mdInjected = true</script>
<img src="x" onerror="window.__mdInjected = true">

## 설정

| 항목 | 값 |
| --- | --- |
| 샘플링 레이트 | 40000 |
| 피치 | +12 |

```python
def convert(path: str) -> None:
    print("변환", path)
```

> 인용문: 학습 데이터는 10분 이상 권장.

### 단계

1. 데이터 준비
2. 학습
3. 추론

마지막 줄입니다.
