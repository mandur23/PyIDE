# Logs every pytest session to runs.log ("start <pid> <time>" / "end <pid> <time>") and notes "overlap" when a session
# starts while the previous one is still alive, so verify/auto-test.mjs can count runs and check they never overlap.
import ctypes
import os
import time

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, 'runs.log')
LOCK = os.path.join(HERE, 'running.pid')


def _alive(pid):
    k = ctypes.windll.kernel32
    h = k.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return False
    code = ctypes.c_ulong()
    ok = k.GetExitCodeProcess(h, ctypes.byref(code))
    k.CloseHandle(h)
    return bool(ok) and code.value == 259  # STILL_ACTIVE


def _log(text):
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write(f'{text} {os.getpid()} {time.time():.3f}\n')


def pytest_sessionstart(session):
    try:
        with open(LOCK, encoding='utf-8') as f:
            other = int(f.read().strip() or 0)
        if other and other != os.getpid() and _alive(other):
            _log('overlap')
    except (OSError, ValueError):
        pass
    with open(LOCK, 'w', encoding='utf-8') as f:
        f.write(str(os.getpid()))
    _log('start')


def pytest_sessionfinish(session, exitstatus):
    _log('end')
    try:
        os.remove(LOCK)
    except OSError:
        pass
