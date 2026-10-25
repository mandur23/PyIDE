"""Expected and actual values of a failed equality assertion, for the Test Results view's <Click to see difference>.

Used by pyide_pytest_plugin.py (pytest's `assert a == b` and TestCase.assertEqual under pytest) and by
pyide_unittest_runner.py. The operands are kept when the assertion fails and turned into text only once the test has
failed on that assertion, so a comparison the test catches costs nothing.
"""
import functools
import pprint
import unittest

# unittest and pytest leave frames of modules with this global out of failure tracebacks.
__unittest = True

LIMIT = 200000
# Every element prints as at least three characters ("1, " or "1,\n"), so formatting more than this many elements
# cannot change the first LIMIT characters of a list or tuple. Larger values are cut before pprint, whose cost is
# linear in their size.
ELEMENTS = LIMIT // 3


class _More:
    def __repr__(self):
        return "..."


_MORE = _More()
_CONTAINERS = (list, tuple, set, frozenset, dict)


def _count(value, budget):
    """The number of elements in `value`, counted until it passes `budget`."""
    n = 1
    if type(value) in _CONTAINERS:
        for item in (value.items() if type(value) is dict else value):
            n += _count(item, budget - n)
            if n > budget:
                break
    return n


def _cut(value, left):
    """`value` with at most left[0] elements, the rest of each container shown as `...`."""
    kind = type(value)
    left[0] -= 1
    if kind not in _CONTAINERS:
        return value[:LIMIT] if kind is str and len(value) > LIMIT else value
    items = []
    for item in (value.items() if kind is dict else value):
        if left[0] <= 0:
            items.append((_MORE, _MORE) if kind is dict else _MORE)
            break
        items.append(tuple(_cut(part, left) for part in item) if kind is dict else _cut(item, left))
    return kind(items)


def _text(value):
    try:
        if _count(value, ELEMENTS) > ELEMENTS:
            value = _cut(value, [ELEMENTS])
        text = pprint.pformat(value, width=80)
    except Exception:
        try:
            text = repr(value)
        except Exception:
            text = "<unprintable %s object>" % type(value).__name__
    return text


def pair(actual, expected):
    """{expected, actual} as text: two strings as they are (line by line), anything else pretty-printed."""
    if isinstance(actual, str) and isinstance(expected, str):
        texts = expected, actual
    else:
        texts = _text(expected), _text(actual)
    expected, actual = (t if len(t) <= LIMIT else t[:LIMIT] + "\n..." for t in texts)
    return {"expected": expected, "actual": actual}


def capture_assert_equal(record):
    """Makes a failing TestCase.assertEqual(first, second) call record((first, second), exception) before raising."""
    original = unittest.TestCase.assertEqual
    if getattr(original, "_pyide_diff", False):
        return

    @functools.wraps(original)
    def assertEqual(self, first, second, msg=None):
        __tracebackhide__ = True
        try:
            original(self, first, second, msg)
        except self.failureException as exc:
            record((first, second), exc)
            raise

    assertEqual._pyide_diff = True
    unittest.TestCase.assertEqual = assertEqual
