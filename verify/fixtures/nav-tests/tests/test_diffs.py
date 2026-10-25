import unittest


def test_dict():
    assert {"a": 1, "b": [1, 2, 3]} == {"a": 1, "b": [1, 2, 4]}


def test_lines():
    assert "alpha\nbeta\ngamma\n" == "alpha\nBETA\ngamma\n"


def test_no_compare():
    assert 3 < 2


def test_caught_then_error():
    try:
        assert 1 == 2
    except AssertionError:
        pass
    raise ValueError("not an assertion")


class TestUnit(unittest.TestCase):
    def test_equal(self):
        self.assertEqual([1, 2, 3], [1, 2, 4])
