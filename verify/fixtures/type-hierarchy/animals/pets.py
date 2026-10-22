from animals.base import Animal, Container, Swimmer


class Dog(Animal):
    def speak(self) -> str:
        return "woof"


class Duck(Animal, Swimmer):
    pass


class Puppy(Dog):
    pass


class Kennel(Container[Dog]):
    pass
