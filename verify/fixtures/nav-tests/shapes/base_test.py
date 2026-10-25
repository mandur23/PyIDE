from shapes.base import Shape


def test_shape_is_abstract():
    assert getattr(Shape.area, "__isabstractmethod__", False)
