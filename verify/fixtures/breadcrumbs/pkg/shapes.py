"""Shapes with nested classes and functions."""


class Outer:
    """A class with a nested class."""

    class Inner:
        def method(self, x):
            total = x * 2
            return total

        def other(self):
            return 1

    def run(self):
        def helper(n):
            return n + 1
        return helper(3)


def compute(value):
    return scale(value) + offset(value)


def scale(value):
    return value * 10


def offset(value):
    return value - 1
