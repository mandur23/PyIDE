from main import Shop, compute


def test_compute():
    assert compute([1, 2]) == 3


class TestShop:
    def test_total(self):
        assert Shop().total() == 3

    def test_items(self):
        assert "apple" in Shop().items
