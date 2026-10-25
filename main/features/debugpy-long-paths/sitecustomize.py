# Debug puts this folder first on PYTHONPATH for a debuggee in an 8.3 working folder (main/features/debug.js), so the
# long names are in place before `python -m debugpy` starts, with no launcher frame under the program: pydevd reports
# an exception that ends the program differently when the outermost frame is a `-c` script's.
# The interpreter's own sitecustomize, if it has one, still runs.
import importlib.machinery
import importlib.util
import os
import sys

import pyide_long_paths

pyide_long_paths.install()

_here = os.path.normcase(os.path.dirname(os.path.abspath(__file__)))
_rest = [p for p in sys.path if os.path.normcase(os.path.abspath(p or os.curdir)) != _here]
_spec = importlib.machinery.PathFinder.find_spec("sitecustomize", _rest)
if _spec and _spec.loader:
    _own = importlib.util.module_from_spec(_spec)
    sys.modules["sitecustomize"] = _own
    _spec.loader.exec_module(_own)
