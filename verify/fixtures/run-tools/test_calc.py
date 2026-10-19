import pytest

from calc import add, div


def test_add():
    assert add(2, 2) == 4


def test_add_wrong():
    print("about to compare")
    assert add(2, 2) == 5


@pytest.mark.skip(reason="not ready")
def test_skipped():
    pass


class TestDiv:
    def test_div(self):
        assert div(6, 3) == 2

    def test_div_zero(self):
        div(1, 0)
