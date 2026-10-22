from animals.pets import Duck, Kennel, Puppy


class RubberDuck(Duck):
    pass


def main() -> None:
    duck = RubberDuck()
    print(Puppy().speak(), duck.swim(), Kennel(Puppy()).item)


if __name__ == "__main__":
    main()
