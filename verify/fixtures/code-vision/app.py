from shapes import Point, Shape, Square, make_square, 인사


def total_area(shapes: list[Shape]) -> int:
    return sum(s.area() for s in shapes)


def main():
    a = make_square(2)
    b = make_square(3)
    c = Square(4)
    items: list[Shape] = [a, b, c]
    print(total_area(items), c.describe(), Point(1, 2))
    print(인사("세계"))


if __name__ == "__main__":
    main()
