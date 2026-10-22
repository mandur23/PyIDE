# 인사말을 만드는 모듈
def greet(name: str) -> str:
    """이름으로 인사합니다.

    >>> greet("철수")
    '안녕하세요, 철수님'
    """
    return f"안녕하세요, {name}님"


def farewell(name: str) -> str:
    return f"안녕히 가세요, {name}님"
