from . import base as b
from .circle import Circle
from .colors import Color as Colour


class Styled:
    colour: Colour

    def __init__(self, colour: Colour):
        self.colour = colour
        self.outline: "b.Named | None" = None


class StyledCircle(Circle, Styled):
    """Multiple inheritance across modules."""

    def __init__(self, name: str, colour: Colour):
        Circle.__init__(self, name)
        Styled.__init__(self, colour)
