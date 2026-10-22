from abc import ABC, abstractmethod


class Named:
    label = "named"

    def __init__(self, name: str):
        self.name = name
        self._secret = 1
        self.__very_private = 2

    def describe(self) -> str:
        return self.name

    def _protected_helper(self):
        return self._secret

    def __mangled(self):
        return self.__very_private


class Shape(Named, ABC):
    sides: int = 0

    @abstractmethod
    def area(self) -> float:
        ...

    @property
    def kind(self) -> str:
        return type(self).__name__

    @kind.setter
    def kind(self, value):
        pass

    @staticmethod
    def unit() -> str:
        return "cm"

    @classmethod
    def create(cls, name: str = "x") -> "Shape":
        return cls(name)

    async def render(self, scale: float = 1.0) -> None:
        return None
