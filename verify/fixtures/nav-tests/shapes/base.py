from abc import ABC, abstractmethod


class Shape(ABC):
    @abstractmethod
    def area(self) -> float:
        ...

    def describe(self) -> str:
        return f"{type(self).__name__} with area {self.area()}"


class Polygon(Shape):
    def sides(self) -> int:
        return 0
