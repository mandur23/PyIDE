from dataclasses import dataclass, field
from typing import ClassVar, List, Optional, TYPE_CHECKING

import shapes.base
from shapes import colors as palette

if TYPE_CHECKING:
    from shapes.styled import StyledCircle


@dataclass
class Canvas:
    shapes: List["shapes.base.Shape"] = field(default_factory=list)
    background: Optional[palette.Color] = None
    title: str = "untitled"
    count: ClassVar[int] = 0
    highlight: "StyledCircle | None" = None

    def add(self, shape: "shapes.base.Shape") -> None:
        self.shapes.append(shape)


class Square(shapes.base.Shape):
    def __init__(self, name: str, side: float):
        super().__init__(name)
        self.side = side

    def area(self) -> float:
        return self.side * self.side

    class Corner:
        """A nested class."""
        index: int = 0
