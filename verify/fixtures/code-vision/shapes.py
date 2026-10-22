"""Shapes used across the project."""
from dataclasses import dataclass

DOC = """
def not_a_function():
    pass
"""


class Shape:
    def area(self):
        return 0

    def describe(self):
        return f"{type(self).__name__} with area {self.area()}"


class Square(Shape):
    def __init__(self, side):
        self.side = side

    def area(self):
        return self.side * self.side

    class Meta:
        label = "square"


@dataclass
class Point:
    x: int
    y: int


# Notes line 1: shapes are measured in whole units.
# Notes line 2: shapes are measured in whole units.
# Notes line 3: shapes are measured in whole units.
# Notes line 4: shapes are measured in whole units.
# Notes line 5: shapes are measured in whole units.
# Notes line 6: shapes are measured in whole units.
# Notes line 7: shapes are measured in whole units.
# Notes line 8: shapes are measured in whole units.
# Notes line 9: shapes are measured in whole units.
# Notes line 10: shapes are measured in whole units.
# Notes line 11: shapes are measured in whole units.
# Notes line 12: shapes are measured in whole units.
# Notes line 13: shapes are measured in whole units.
# Notes line 14: shapes are measured in whole units.
# Notes line 15: shapes are measured in whole units.
# Notes line 16: shapes are measured in whole units.
# Notes line 17: shapes are measured in whole units.
# Notes line 18: shapes are measured in whole units.
# Notes line 19: shapes are measured in whole units.
# Notes line 20: shapes are measured in whole units.
# Notes line 21: shapes are measured in whole units.
# Notes line 22: shapes are measured in whole units.
# Notes line 23: shapes are measured in whole units.
# Notes line 24: shapes are measured in whole units.
# Notes line 25: shapes are measured in whole units.
# Notes line 26: shapes are measured in whole units.
# Notes line 27: shapes are measured in whole units.
# Notes line 28: shapes are measured in whole units.
# Notes line 29: shapes are measured in whole units.
# Notes line 30: shapes are measured in whole units.
# Notes line 31: shapes are measured in whole units.
# Notes line 32: shapes are measured in whole units.
# Notes line 33: shapes are measured in whole units.
# Notes line 34: shapes are measured in whole units.
# Notes line 35: shapes are measured in whole units.
# Notes line 36: shapes are measured in whole units.
# Notes line 37: shapes are measured in whole units.
# Notes line 38: shapes are measured in whole units.
# Notes line 39: shapes are measured in whole units.
# Notes line 40: shapes are measured in whole units.
# Notes line 41: shapes are measured in whole units.
# Notes line 42: shapes are measured in whole units.
# Notes line 43: shapes are measured in whole units.
# Notes line 44: shapes are measured in whole units.
# Notes line 45: shapes are measured in whole units.
# Notes line 46: shapes are measured in whole units.
# Notes line 47: shapes are measured in whole units.
# Notes line 48: shapes are measured in whole units.
# Notes line 49: shapes are measured in whole units.
# Notes line 50: shapes are measured in whole units.
# Notes line 51: shapes are measured in whole units.
# Notes line 52: shapes are measured in whole units.
# Notes line 53: shapes are measured in whole units.
# Notes line 54: shapes are measured in whole units.
# Notes line 55: shapes are measured in whole units.
# Notes line 56: shapes are measured in whole units.
# Notes line 57: shapes are measured in whole units.
# Notes line 58: shapes are measured in whole units.
# Notes line 59: shapes are measured in whole units.
# Notes line 60: shapes are measured in whole units.


def make_square(side):
    return Square(side)


async def load_shapes(
    names,
):
    return [make_square(len(n)) for n in names]


def unused_helper():
    def inner():
        return "inner"
    return inner()


def 인사(이름):
    return f"안녕하세요, {이름}"


if True:
    def conditional():
        return 1
