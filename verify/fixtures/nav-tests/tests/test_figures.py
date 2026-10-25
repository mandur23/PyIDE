from shapes.figures import Circle, Square


class TestSquare:
    def test_area(self):
        assert Square(2).area() == 4

    def test_describe(self):
        assert Square(1).describe() == "square"


def test_circle():
    assert round(Circle(1).area(), 2) == 3.14
