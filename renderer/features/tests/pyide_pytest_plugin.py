"""pytest plugin that streams collection and results as JSON lines to $PYIDE_TEST_REPORT for the Test Results view."""
import json
import os

_out = None


def _emit(event):
    global _out
    if _out is None:
        _out = open(os.environ["PYIDE_TEST_REPORT"], "a", encoding="utf-8")
    _out.write(json.dumps(event) + "\n")
    _out.flush()


def _text(longrepr):
    if not longrepr:
        return ""
    if isinstance(longrepr, tuple) and len(longrepr) == 3:
        return str(longrepr[2])
    return str(longrepr)


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
    _emit({"e": "start", "id": nodeid})


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
    _emit({
        "e": "result",
        "id": report.nodeid,
        "when": report.when,
        "outcome": outcome,
        "duration": report.duration,
        "text": _text(report.longrepr),
        "output": sections,
    })


def pytest_sessionfinish(session, exitstatus):
    _emit({"e": "done", "exit": int(exitstatus)})
