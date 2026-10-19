import unittest

from calc import add


class AddTest(unittest.TestCase):
    def test_ok(self):
        self.assertEqual(add(1, 1), 2)

    def test_bad(self):
        self.assertEqual(add(1, 1), 3)

    @unittest.skip("later")
    def test_later(self):
        pass
