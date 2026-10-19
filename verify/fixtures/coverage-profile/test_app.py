from app import classify
from util.text import shout


def test_negative():
    assert classify(-1) == 'negative'


def test_shout():
    assert shout('hi') == 'HI!'
