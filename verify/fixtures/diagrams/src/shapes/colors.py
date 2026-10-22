from enum import Enum, auto


class Color(Enum):
    RED = 1
    GREEN = 2
    BLUE = auto()

    def hex(self) -> str:
        return "#000"
