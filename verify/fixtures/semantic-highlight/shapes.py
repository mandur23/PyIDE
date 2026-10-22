"""Shapes for the semantic highlighting check."""
import os
from dataclasses import dataclass
from typing import Generic, TypeVar

T = TypeVar("T")
MAX_SIZE = 100


def decorate(fn):
    return fn


@dataclass
class Point:
    x: int
    y: int

    @property
    def norm(self) -> float:
        return (self.x ** 2 + self.y ** 2) ** 0.5

    @classmethod
    def origin(cls) -> "Point":
        return cls(0, 0)

    def moved(self, dx: int, dy: int) -> "Point":
        return Point(self.x + dx, self.y + dy)


class Box(Generic[T]):
    def __init__(self, item: T) -> None:
        self.item = item


def first[U](items: list[U]) -> U:
    return items[0]


def area(width: int, height: int) -> int:
    total = width * height
    print(len(os.sep), MAX_SIZE)
    return total


@decorate
def main() -> None:
    p = Point.origin()
    print(p.norm, p.moved(1, 2), area(3, 4), first([Box(1)]).item)
