from helper import scale


def compute(values):
    total = 0
    for v in values:
        total += scale(v)
    return total


if __name__ == "__main__":
    data = [1, 2, 3]
    result = compute(data)
    print(f"result={result}")
