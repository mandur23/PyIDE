def area(w, h):
    """Area of a rectangle."""
    return w * h


def perimeter(w, h):
    return 2 * (w + h)


class Box:
    def __init__(self, w, h):
        self.w = w
        self.h = h

    def volume(self, d):
        return self.w * self.h * d


if __name__ == "__main__":
    print(area(2, 3))
