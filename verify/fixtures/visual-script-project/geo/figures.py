"""Shapes and their sizes."""
import math


def area(r: float) -> float:
    """Area of a circle with radius r, rounded to 2 places."""
    return round(math.pi * r * r, 2)


def perimeter(w: float, h: float = 1, *, double: bool = False) -> float:
    """Perimeter of a w by h rectangle."""
    p = 2 * (w + h)
    return p * 2 if double else p


def total(*values, scale=1):
    """Sum of the values times scale."""
    return sum(values) * scale


def describe(**fields) -> str:
    """The fields as name=value pairs."""
    return ', '.join(f'{k}={v}' for k, v in sorted(fields.items()))


async def slow_square(x: int) -> int:
    """x squared, after a tiny pause."""
    import asyncio
    await asyncio.sleep(0.01)
    return x * x


class Rect:
    """A rectangle."""

    def __init__(self, w: float, h: float = 1):
        self.w = w
        self.h = h

    def area(self) -> float:
        """Width times height."""
        return self.w * self.h

    @staticmethod
    def unit() -> 'Rect':
        """The 1 by 1 rectangle."""
        return Rect(1, 1)

    @classmethod
    def square(cls, side: float) -> 'Rect':
        """A side by side rectangle."""
        return cls(side, side)

    @property
    def wide(self):
        return self.w > self.h

    def _hidden(self):
        pass
