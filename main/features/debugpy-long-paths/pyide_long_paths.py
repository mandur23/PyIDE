"""Long file names for a debuggee started in an 8.3 working folder (main/features/debug.js).

The modules a run imports from such a folder get 8.3 file names, which pydevd cannot resolve once their long form
exceeds MAX_PATH ("unable to get real case"). That covers `-m over` (the folder and '' on sys.path) and pytest's test
files, which pytest imports through a sys.path entry it builds from the folder (`<folder>\\tests`, partly resolved).
Every sys.path entry with a short name in it then imports through a finder rooted at its long form (GetLongPathNameW
on the \\\\?\\ form, which has no MAX_PATH limit), when Python can read it there. Changing to the long folder would do as
much for pytest, but a process whose current folder is past MAX_PATH cannot start a child (CreateProcess fails with
"The parameter is incorrect").
"""
import os
import sys


def install():
    import ctypes

    hooks = list(sys.path_hooks)
    prefix = os.sep * 2 + "?" + os.sep

    def long_form(entry):
        full = os.path.abspath(entry or os.getcwd())
        buf = ctypes.create_unicode_buffer(32768)
        if "~" not in full or not 0 < ctypes.windll.kernel32.GetLongPathNameW(prefix + full, buf, 32768) < 32768:
            raise ImportError(entry)
        long = buf.value[len(prefix):] if buf.value.startswith(prefix) else buf.value
        if long == full or not os.path.isdir(long):
            raise ImportError(entry)
        for hook in hooks:
            try:
                return hook(long)
            except ImportError:
                pass
        raise ImportError(entry)

    sys.path_hooks.insert(0, long_form)
    sys.path_importer_cache.clear()
