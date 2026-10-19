import sys


def greet(name):
    return f"Hello, {name}!"


def add(a, b):
    return a + b


def main():
    print(greet("PyIDE"))
    print(add(2, 3))


if __name__ == "__main__":
    main()
