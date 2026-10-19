"""Shapes used by the AI edit checks."""


def area(w, h):
    """Area of a rectangle."""
    return w * h


def perimeter(w, h):
    return 2 * (w + h)


class Point:
    def __init__(self, x, y):
        self.x = x
        self.y = y

    def norm(self):
        return (self.x ** 2 + self.y ** 2) ** 0.5
