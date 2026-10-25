from shapes.base import Polygon, Shape


class Square(Polygon):
    def __init__(self, side: float) -> None:
        self.side = side

    def area(self) -> float:
        return self.side * self.side

    def sides(self) -> int:
        return 4

    def describe(self) -> str:
        return "square"


class Circle(Shape):
    def __init__(self, r: float) -> None:
        self.r = r

    def area(self) -> float:
        return 3.14159 * self.r * self.r


def total_area(items: list[Shape]) -> float:
    return sum(s.area() for s in items)
