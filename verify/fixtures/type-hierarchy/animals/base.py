from typing import Generic, TypeVar

T = TypeVar("T")


class Named:
    name = "named"


class Animal(Named):
    def speak(self) -> str:
        return "..."


class Swimmer:
    def swim(self) -> str:
        return "splash"


class Container(Generic[T]):
    def __init__(self, item: T) -> None:
        self.item = item
