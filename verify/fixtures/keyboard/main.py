# TODO: keyboard fixture marker
class Shop:
    def __init__(self):
        self.items = {"apple": 1, "pear": 2}

    def total(self):
        return sum(self.items.values())


def compute(values):
    total = 0
    for v in values:
        total += v
    return total


info = {"name": "demo", "size": 3}
result = compute([1, 2, 3])
print(result, Shop().total(), info)
