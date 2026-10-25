"""Small helpers without tests yet."""
import math


def clamp(x, lo, hi):
    return max(lo, min(x, hi))


def lerp(a, b, t):
    return a + (b - a) * t


class Vector:
    def __init__(self, x, y):
        self.x = x
        self.y = y

    def length(self):
        return math.hypot(self.x, self.y)

    def _cache(self):
        return None
