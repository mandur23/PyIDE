from abc import ABC, abstractmethod


class Shape(ABC):
    @abstractmethod
    def area(self) -> float:
        ...

    def describe(self) -> str:
        return f"{type(self).__name__} with area {self.area()}"


class Square(Shape):
    def __init__(self, side: float):
        self.side = side

    def report(self):
        return self.summary(self.side)
