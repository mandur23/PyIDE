def mean(values):
    """Arithmetic mean of a non-empty list of numbers."""
    total = 0
    for v in values:
        total += v
    return total / len(values)


def variance(values):
    """Population variance of a non-empty list of numbers."""
    m = mean(values)
    return sum((v - m) ** 2 for v in values) / len(values)


def clamp(value, low, high):
    """Limit value to the range [low, high]."""
