"""unittest fallback for the Test Results view when pytest is not installed.

usage: pyide_unittest_runner.py ROOT [TARGET ...] where TARGET is a pytest-style node id: path[::Class[::method]].
Writes the same JSON-lines events as pyide_pytest_plugin.py to $PYIDE_TEST_REPORT.
"""
import inspect
import io
import json
import os
import sys
import time
import unittest

ROOT = os.path.abspath(sys.argv[1])
TARGETS = sys.argv[2:] or [ROOT]
REPORT = os.environ["PYIDE_TEST_REPORT"]  # a path, or fd:N from remote interpreters (see pyide_pytest_plugin.py)
OUT = open(int(REPORT[3:]) if REPORT.startswith("fd:") else REPORT, "a", encoding="utf-8")
MARK = "\x1ePYIDE-TEST " if os.environ.get("PYIDE_TEST_REPORT_MARK") else ""
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)


def emit(event):
    OUT.write(MARK + json.dumps(event) + "\n")
    OUT.flush()


def flatten(suite):
    for test in suite:
        if isinstance(test, unittest.TestSuite):
            yield from flatten(test)
        else:
            yield test


def describe(test):
    method = getattr(test, "_testMethodName", "")
    cls = type(test)
    func = getattr(cls, method, None)
    try:
        file = None if cls.__name__ == "_FailedTest" else inspect.getsourcefile(cls)
    except TypeError:
        file = None
    try:
        line = inspect.getsourcelines(func)[1] if func else inspect.getsourcelines(cls)[1]
    except (TypeError, OSError):
        line = 1
    if not file:
        # unittest.loader._FailedTest: an import error while loading a module
        name = test.id().split(".")[-1]
        return {"id": test.id(), "file": "", "line": 1, "cls": None, "name": name}
    rel = os.path.relpath(file, ROOT).replace(os.sep, "/")
    return {"id": "%s::%s::%s" % (rel, cls.__name__, method), "file": file, "line": line, "cls": cls.__name__, "name": method}


def load(target):
    path, _, rest = target.partition("::")
    path = os.path.abspath(os.path.join(ROOT, path))
    loader = unittest.TestLoader()
    if os.path.isdir(path):
        suite = loader.discover(path, top_level_dir=ROOT)
    else:
        suite = loader.discover(os.path.dirname(path), pattern=os.path.basename(path), top_level_dir=ROOT)
    parts = rest.split("::") if rest else []
    tests = []
    for test in flatten(suite):
        if parts and type(test).__name__ != parts[0]:
            continue
        if len(parts) > 1 and getattr(test, "_testMethodName", "") != parts[1].split("[")[0]:
            continue
        tests.append(test)
    return tests


class Result(unittest.TestResult):
    def __init__(self, info):
        super().__init__()
        self.info = info
        self.buffer = True

    def startTest(self, test):
        self.started = time.perf_counter()
        emit({"e": "start", "id": self.info[test]["id"]})
        super().startTest(test)

    def report(self, test, outcome, text=""):
        out = ""
        if self._stdout_buffer is not None:
            out += self._stdout_buffer.getvalue()
        if self._stderr_buffer is not None:
            out += self._stderr_buffer.getvalue()
        emit({"e": "result", "id": self.info[test]["id"], "when": "call", "outcome": outcome,
              "duration": time.perf_counter() - self.started, "text": text,
              "output": ("\n----- Captured output -----\n" + out) if out else ""})

    def addSuccess(self, test):
        self.report(test, "passed")
        super().addSuccess(test)

    def addFailure(self, test, err):
        self.report(test, "failed", self._exc_info_to_string(err, test))
        super().addFailure(test, err)

    def addError(self, test, err):
        self.report(test, "error", self._exc_info_to_string(err, test))
        super().addError(test, err)

    def addSkip(self, test, reason):
        self.report(test, "skipped", reason)
        super().addSkip(test, reason)

    def addExpectedFailure(self, test, err):
        self.report(test, "skipped", "expected failure")
        super().addExpectedFailure(test, err)

    def addUnexpectedSuccess(self, test):
        self.report(test, "failed", "unexpected success")
        super().addUnexpectedSuccess(test)


def main():
    tests, seen = [], set()
    for target in TARGETS:
        for test in load(target):
            if test.id() not in seen:
                seen.add(test.id())
                tests.append(test)
    info = {test: describe(test) for test in tests}
    emit({"e": "collected", "tests": list(info.values())})
    result = Result(info)
    suite = unittest.TestSuite(tests)
    started = time.perf_counter()
    suite.run(result)
    elapsed = time.perf_counter() - started
    print("Ran %d test%s in %.3fs" % (result.testsRun, "" if result.testsRun == 1 else "s", elapsed))
    for test, text in result.errors + result.failures:
        print("=" * 70)
        print("FAIL: %s" % info.get(test, {"id": test.id()})["id"])
        print("-" * 70)
        print(text)
    bad = len(result.failures) + len(result.errors) + len(result.unexpectedSuccesses)
    print("FAILED (failures=%d)" % bad if bad else "OK")
    emit({"e": "done", "exit": 1 if bad else 0})
    sys.exit(1 if bad else 0)


main()
