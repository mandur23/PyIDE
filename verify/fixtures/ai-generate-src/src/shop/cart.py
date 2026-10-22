def total(prices: list[float]) -> float:
    """Sum of the prices.

    >>> total([1.5, 2.5])
    4.0
    >>> total([-1.0])
    Traceback (most recent call last):
    ValueError: negative price
    """
    if any(p < 0 for p in prices):
        raise ValueError("negative price")
    return sum(prices)
