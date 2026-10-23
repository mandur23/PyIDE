def shout(text: str, times: int = 1, sep: str = ' ') -> str:
    """The text in capitals, repeated."""
    return sep.join([text.upper() + '!'] * times)


def area(w, h):
    """Not a circle: the area of a w by h rectangle."""
    return w * h
