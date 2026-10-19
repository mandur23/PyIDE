from helper import scale


def compute(values):
    total = 0
    for v in values:
        total += scale(v)
    return total


data = [1, 2, 3]
info = {"name": "demo", "size": len(data)}
result = compute(data)
name = input("name? ")
print(f"result={result} name={name}")
print("done")
