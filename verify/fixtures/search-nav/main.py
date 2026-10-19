"""Entry point used by the search-nav verification."""
import sys

from pkg.models import UserModel

VERSION = "1.0"
MAX_USERS: int = 10


class Greeter:
    """Greets people."""

    greeting = "Hello"

    def __init__(self, name):
        self.name = name
        self.count = 0

    def greet(self, punctuation="!"):
        # TODO: support other languages
        self.count += 1
        return f"{self.greeting}, {self.name}{punctuation}"

    @property
    def times(self) -> int:
        return self.count


def compute(a, b=2):
    total = a * b
    return total


def helper():
    def inner():
        return compute(1)

    return inner()


def main():
    g = Greeter("PyIDE")
    print(g.greet())
    print(compute(3))
    user = UserModel("ann")
    print(user.label())
    return 0


if __name__ == "__main__":
    sys.exit(main())
