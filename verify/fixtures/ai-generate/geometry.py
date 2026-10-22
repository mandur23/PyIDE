def scale(value: float, factor: float) -> float:
    """Scale a value.

    Args:
        value: The value.
        factor: The factor.

    Returns:
        The scaled value.
    """
    return value * factor


def shift(value: float, offset: float) -> float:
    """Shift a value.

    Args:
        value: The value.
        offset: The offset.

    Returns:
        The shifted value.
    """
    return value + offset
