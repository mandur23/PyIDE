from models import Greeter, make_greeter


def main() -> None:
    greeter = make_greeter("Hi")
    message = greeter.greet("PyIDE")
    print(message)
    other = Greeter()
    print(other.greet("world"))


if __name__ == "__main__":
    main()
