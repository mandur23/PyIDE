from shapes.base import Polygon


def test_polygon_sides():
    assert Polygon().sides() == 0
