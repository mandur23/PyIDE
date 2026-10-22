import math


def area(width: float, height: float) -> float:
    if width < 0 or height < 0:
        raise ValueError("negative size")
    return width * height


def circle_area(radius: float) -> float:
    """Old docstring.

    >>> round(circle_area(1.0), 2)
    3.14
    """
    return math.pi * radius ** 2


def checked(value: int) -> int:
    """Return the value when it is not negative.

    >>> checked(3)
    3
    >>> checked(-1)
    Traceback (most recent call last):
    ValueError: negative
    """
    if value < 0:
        raise ValueError("negative")
    return value


class Rect:
    def __init__(self, width: float, height: float) -> None:
        self.width = width
        self.height = height

    def area(self) -> float:
        """Area of the rectangle.

        >>> Rect(2, 3).area()
        6
        """
        return area(self.width, self.height)
