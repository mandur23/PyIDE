import time

import mathlib


def test_add():
    time.sleep(mathlib.DELAY)
    assert mathlib.add(2, 3) == 5
