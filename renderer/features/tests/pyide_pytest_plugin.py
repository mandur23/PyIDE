"""pytest plugin that streams collection and results as JSON lines to $PYIDE_TEST_REPORT for the Test Results view."""
import json
import os

import pytest

import pyide_test_diff

_out = None
# Remote interpreters pass a descriptor (PYIDE_TEST_REPORT=fd:3) that shares a stream with other output, so each
# line is marked for the IDE to take out.
_MARK = "\x1ePYIDE-TEST " if os.environ.get("PYIDE_TEST_REPORT_MARK") else ""


def _target():
    path = os.environ["PYIDE_TEST_REPORT"]
    return int(path[3:]) if path.startswith("fd:") else path


def _emit(event):
    global _out
    if _out is None:
        _out = open(_target(), "a", encoding="utf-8")
    _out.write(_MARK + json.dumps(event) + "\n")
    _out.flush()


def _text(longrepr):
    if not longrepr:
        return ""
    if isinstance(longrepr, tuple) and len(longrepr) == 3:
        return str(longrepr[2])
    return str(longrepr)


# The expected/actual pair of the running test's last failed `==` (pytest_assertrepr_compare) or assertEqual, with the
# exception assertEqual raised (None for `==`, whose exception is raised after the hook).
_current = None
_diffs = {}


def _record(diff, exc=None):
    if _current is not None:
        _diffs[_current] = (diff, exc)


def pytest_configure(config):
    pyide_test_diff.capture_assert_equal(_record)


def pytest_assertrepr_compare(config, op, left, right):
    if op == "==":
        _record(pyide_test_diff.pair(left, right))


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    if call.when != "call":
        return
    diff, exc = _diffs.pop(item.nodeid, (None, None))
    err = call.excinfo.value if call.excinfo is not None else None
    # Only the assertion that failed the test: not one the test caught, nor a later error of another kind.
    if diff and isinstance(err, AssertionError) and (exc is None or exc is err):
        outcome.get_result().pyide_diff = diff


def pytest_collection_finish(session):
    tests = []
    for item in session.items:
        _, lineno, _ = item.location
        cls = getattr(item, "cls", None)
        tests.append({
            "id": item.nodeid,
            "file": str(getattr(item, "path", "") or item.fspath),
            "line": (lineno or 0) + 1,
            "cls": cls.__name__ if cls else None,
            "name": item.name,
        })
    _emit({"e": "collected", "tests": tests})


def pytest_collectreport(report):
    if report.failed:
        _emit({"e": "collecterror", "id": report.nodeid, "text": _text(report.longrepr)})


def pytest_runtest_logstart(nodeid, location):
    global _current
    _current = nodeid
    _diffs.pop(nodeid, None)
    _emit({"e": "start", "id": nodeid})


def pytest_runtest_logfinish(nodeid, location):
    global _current
    _current = None


def pytest_runtest_logreport(report):
    if report.when != "call" and report.passed:
        return
    if report.when == "call":
        outcome = report.outcome
    elif report.skipped:
        outcome = "skipped"
    else:
        outcome = "error"
    if hasattr(report, "wasxfail"):
        outcome = "skipped" if report.skipped else "passed"
    sections = "".join("\n----- %s -----\n%s" % (title, body) for title, body in report.sections if body)
    event = {
        "e": "result",
        "id": report.nodeid,
        "when": report.when,
        "outcome": outcome,
        "duration": report.duration,
        "text": _text(report.longrepr),
        "output": sections,
    }
    diff = getattr(report, "pyide_diff", None)
    if diff and outcome == "failed":
        event["diff"] = diff
    _emit(event)


def pytest_sessionfinish(session, exitstatus):
    _emit({"e": "done", "exit": int(exitstatus)})
