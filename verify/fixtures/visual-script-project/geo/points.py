from dataclasses import dataclass


@dataclass
class Point:
    """A point in the plane."""
    x: float
    y: float = 0

    def dist(self) -> float:
        """Distance from the origin."""
        return (self.x ** 2 + self.y ** 2) ** 0.5
