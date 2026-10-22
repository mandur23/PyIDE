from .base import Shape


class Circle(Shape):
    sides = 0

    def __init__(self, name: str, radius: float = 1.0):
        super().__init__(name)
        self.radius = radius

    def area(self) -> float:
        return 3.14159 * self.radius ** 2
