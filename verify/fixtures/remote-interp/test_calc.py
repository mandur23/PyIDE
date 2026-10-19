import unittest

from helper import scale


class TestScale(unittest.TestCase):
    def test_double(self):
        self.assertEqual(scale(2), 4)

    def test_wrong(self):
        self.assertEqual(scale(2), 5)
