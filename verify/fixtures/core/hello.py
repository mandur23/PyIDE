import sys
from pkg.util import greet


@staticmethod
def helper(x):
    return x * 2


class Greeter:
    def __init__(self, name):
        self.name = name  # field

    def say(self):
        return greet(self.name)


if __name__ == "__main__":
    print(Greeter("PyIDE").say(), 42, sys.version_info[0])
    name = input("name? ")
    print(f"hi {name}")
    raise ValueError("boom")
