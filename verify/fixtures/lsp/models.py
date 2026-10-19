"""Domain models used by app.py."""


class Greeter:
    """Greets people by name."""

    def __init__(self, greeting: str = "Hello") -> None:
        self.greeting = greeting

    def greet(self, name: str, punctuation: str = "!") -> str:
        """Return a greeting for *name*."""
        return f"{self.greeting}, {name}{punctuation}"


def make_greeter(greeting: str) -> Greeter:
    """Build a Greeter with a custom greeting."""
    return Greeter(greeting)
