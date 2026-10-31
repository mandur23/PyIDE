"""Matplotlib backend that shows figures in PyIDE's Plots tool window instead of opening windows.

PyIDE selects it with MPLBACKEND=module://pyide_sciview_backend for the programs it starts (Run, Debug, the Python
Console) when Settings › Tools › Python Plots › "Show plots in tool window" is on. Figures render with Agg, so
`savefig` and everything else work as usual. `plt.show()` sends every open figure as PNG and SVG over a local
socket (PYIDE_PLOTS_PORT, authenticated by PYIDE_PLOTS_TOKEN), then closes them and returns at once, so a script
never blocks on a window. In the Python Console, matplotlib runs in interactive mode and the console calls
`flush_figures()` after each statement: new or changed figures are sent (a changed one replaces its earlier image)
and stay open, so `fig, ax = plt.subplots()` followed by `ax.plot(...)` updates one plot.
"""
import base64
import io
import json
import os
import socket
import sys

import matplotlib
from matplotlib._pylab_helpers import Gcf
from matplotlib.backend_bases import FigureManagerBase, _Backend
from matplotlib.backends.backend_agg import FigureCanvasAgg

MAX_SVG = 16 * 1024 * 1024
MAX_PNG_SIDE = 4000
_warned = False


def _in_console():
    main = sys.modules.get("__main__")
    return os.path.basename(getattr(main, "__file__", "") or "") == "pyide_repl.py"


def _source():
    if _in_console():
        return "console"
    return os.path.basename(sys.argv[0]) if sys.argv and sys.argv[0] else "python"


def _render(figure):
    width_in, height_in = figure.get_size_inches()
    dpi = min(figure.dpi * 2, MAX_PNG_SIDE / max(width_in, height_in, 1e-3))
    png = io.BytesIO()
    figure.savefig(png, format="png", dpi=dpi)
    svg = None
    try:
        buf = io.BytesIO()
        figure.savefig(buf, format="svg")
        if buf.tell() <= MAX_SVG:
            svg = buf.getvalue().decode("utf-8")
    except Exception:  # noqa: BLE001  (a figure that cannot be vectorised is still shown as PNG)
        pass
    return png.getvalue(), svg, (round(width_in * dpi), round(height_in * dpi))


def _send(manager):
    global _warned
    port = os.environ.get("PYIDE_PLOTS_PORT")
    if not port:
        return False
    figure = manager.canvas.figure
    png, svg, (w, h) = _render(figure)
    title = figure.get_label() or manager.get_window_title() or "Figure %d" % manager.num
    msg = {"token": os.environ.get("PYIDE_PLOTS_TOKEN", ""), "pid": os.getpid(), "key": "%d:%d" % (os.getpid(), id(figure)),
           "title": title, "source": _source(), "png": base64.b64encode(png).decode("ascii"), "svg": svg,
           "width": w, "height": h}
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=10) as s:
            s.sendall(json.dumps(msg).encode("utf-8") + b"\n")
            s.shutdown(socket.SHUT_WR)
            s.recv(16)
    except OSError as exc:
        if not _warned:
            _warned = True
            sys.stderr.write("Nano Studio Plots: could not reach the IDE (%s); the figure is not shown.\n" % exc)
        return False
    figure._pyide_shown = True
    return True


class FigureManagerPyIDE(FigureManagerBase):
    def show(self):
        _send(self)


class FigureCanvasPyIDE(FigureCanvasAgg):
    manager_class = FigureManagerPyIDE


def flush_figures():
    """Sends open figures that are new or changed since they were last shown (the Python Console's hook)."""
    if not matplotlib.is_interactive():
        return
    for manager in Gcf.get_all_fig_managers():
        figure = manager.canvas.figure
        if figure.stale or not getattr(figure, "_pyide_shown", False):
            _send(manager)


@_Backend.export
class _BackendPyIDE(_Backend):
    FigureCanvas = FigureCanvasPyIDE
    FigureManager = FigureManagerPyIDE

    @staticmethod
    def show(block=None):
        managers = Gcf.get_all_fig_managers()
        for manager in managers:
            _send(manager)
        for manager in managers:
            Gcf.destroy(manager)


if _in_console():
    matplotlib.interactive(True)
