"""Expected and actual values of a failed equality assertion, for the Test Results view's <Click to see difference>.

Used by pyide_pytest_plugin.py (pytest's `assert a == b` and TestCase.assertEqual under pytest) and by
pyide_unittest_runner.py. Values are turned into text when the assertion fails, so later changes to them do not show.
"""
import functools
import pprint
import unittest

# unittest and pytest leave frames of modules with this global out of failure tracebacks.
__unittest = True

LIMIT = 200000


def _text(value):
    try:
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
    """Makes a failing TestCase.assertEqual(first, second) call record(pair(first, second), exception) before raising."""
    original = unittest.TestCase.assertEqual
    if getattr(original, "_pyide_diff", False):
        return

    @functools.wraps(original)
    def assertEqual(self, first, second, msg=None):
        __tracebackhide__ = True
        try:
            original(self, first, second, msg)
        except self.failureException as exc:
            record(pair(first, second), exc)
            raise

    assertEqual._pyide_diff = True
    unittest.TestCase.assertEqual = assertEqual
