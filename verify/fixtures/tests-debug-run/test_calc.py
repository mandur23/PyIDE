from calc import add


def test_add():
    value = add(2, 3)
    assert value == 5


def test_wrong():
    assert add(1, 1) == 3
