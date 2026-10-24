"""PyIDE Python Console backend.

Reads raw lines from stdin. A plain line is pushed to an InteractiveConsole like a typed line. A line starting with
\x01 carries a JSON-encoded block (Execute Selection in Console) that runs statement by statement in 'single' mode, so
expression values are echoed the way the interactive prompt does. After every step the console prints a prompt
marker (\x02ps1\x03 or \x02ps2\x03) on stdout so the IDE knows when it is ready and which prompt to show.

A line starting with \x05 is a query from the IDE (the Variables pane, the Data View): JSON [id, expression]. The
expression is evaluated in the console namespace and the answer comes back as \x02q[id, ok, text]\x03 without a
prompt, so a block being typed keeps its state. After each statement, figures for PyIDE's Plots window are flushed
when its matplotlib backend (pyide_sciview_backend) is in use.

A line holding only \x03 is Interrupt: while a statement runs it raises KeyboardInterrupt in it, at the prompt it drops
the block being typed. A reader thread owns the real stdin so it sees \x03 even while the statement blocks; the
statement's own reads (input(), sys.stdin) take the other lines from it through ConsoleInput.
"""
import _thread
import ast
import code
import codecs
import io
import json
import os
import queue
import signal
import sys
import threading
import time
import traceback

PS1 = "\x02ps1\x03"
PS2 = "\x02ps2\x03"
INTERRUPT = "\x03"

for root in reversed(sys.argv[1:]):
    if root not in sys.path:
        sys.path.insert(0, root)
if "" not in sys.path:
    sys.path.insert(0, "")
sys.argv = [""]

namespace = {"__name__": "__main__", "__doc__": None}
console = code.InteractiveConsole(namespace, filename="<input>")

lines = queue.Queue()
state_lock = threading.Lock()
running = False


def interrupt_main():
    # A real SIGINT also wakes a main thread blocked in time.sleep() or a read; interrupt_main() alone would wait for
    # it to return. POSIX (remote interpreters): sent to the main thread itself. Windows: raise_signal runs Python's C
    # handler, which sets the event time.sleep() waits on.
    if callable(signal.getsignal(signal.SIGINT)):
        if hasattr(signal, "pthread_kill"):
            signal.pthread_kill(threading.main_thread().ident, signal.SIGINT)
            return
        if hasattr(signal, "raise_signal"):
            signal.raise_signal(signal.SIGINT)
            return
    _thread.interrupt_main()


def pipe_peek(fd):
    """Windows: a function returning how many bytes wait in the stdin pipe (-1 once it is closed), else None.

    A read left pending on a pipe blocks every other thread that asks the pipe anything (GetFileType), and loading a
    DLL whose C runtime looks at the standard handles does: `import numpy` would hang until the next line arrives. So
    the reader waits for data with PeekNamedPipe and then reads only what is there.
    """
    if sys.platform != "win32":
        return None
    try:
        import ctypes
        import msvcrt
        from ctypes import wintypes

        handle = msvcrt.get_osfhandle(fd)
        peek_pipe = ctypes.WinDLL("kernel32").PeekNamedPipe
        peek_pipe.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p,
                              ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
        peek_pipe.restype = wintypes.BOOL
        avail = wintypes.DWORD()

        def peek():
            return avail.value if peek_pipe(handle, None, 0, None, ctypes.byref(avail), None) else -1

        return peek if peek() >= 0 else None
    except Exception:  # noqa: BLE001  (no ctypes, or stdin is not a pipe: plain blocking reads)
        return None


def read_stdin(fd, peek):
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    rest = ""
    while True:
        while peek is not None and peek() == 0:
            time.sleep(0.02)
        chunk = os.read(fd, 65536)
        rest += decoder.decode(chunk, final=not chunk).replace("\r\n", "\n")
        *done, rest = rest.split("\n")
        for line in done:
            if line == INTERRUPT:
                with state_lock:
                    if running:
                        interrupt_main()
                        continue
            lines.put(line + "\n")
        if not chunk:
            if rest:
                lines.put(rest)
            lines.put("")
            return


def next_line():
    # A timed wait, so KeyboardInterrupt reaches a statement waiting here (lock waits are not interruptible on Windows).
    while True:
        try:
            return lines.get(timeout=0.1)
        except queue.Empty:
            pass


class ConsoleInput(io.TextIOBase):
    """sys.stdin while a statement runs: the lines the IDE sends, \x03 excluded."""

    def __init__(self):
        super().__init__()
        self._rest = ""
        self._eof = False
        self.buffer = ConsoleInputBytes(self)

    @property
    def encoding(self):
        return "utf-8"

    def readable(self):
        return True

    def isatty(self):
        return False

    def _fill(self):
        if self._eof:
            return False
        line = next_line()
        while line.rstrip("\r\n") == INTERRUPT:
            line = next_line()
        if not line:
            lines.put("")  # the main loop ends on it too
            self._eof = True
            return False
        self._rest += line.replace("\r\n", "\n")
        return True

    def _take(self, end):
        text, self._rest = self._rest[:end], self._rest[end:]
        return text

    def readline(self, size=-1):
        limit = size is not None and size >= 0
        while "\n" not in self._rest and not (limit and len(self._rest) >= size) and self._fill():
            pass
        end = self._rest.find("\n") + 1 or len(self._rest)
        return self._take(min(end, size) if limit else end)

    def read(self, size=-1):
        limit = size is not None and size >= 0
        while not (limit and len(self._rest) >= size) and self._fill():
            pass
        return self._take(size if limit else len(self._rest))


class ConsoleInputBytes(io.RawIOBase):
    def __init__(self, text):
        super().__init__()
        self._text = text

    def readable(self):
        return True

    def readline(self, size=-1):
        return self._text.readline(size).encode("utf-8")

    def read(self, size=-1):
        return self._text.read(size).encode("utf-8")


def run(fn, *args):
    global running
    with state_lock:
        running = True
    try:
        return fn(*args)
    finally:
        with state_lock:
            running = False


def prompt(more):
    sys.stderr.flush()
    sys.stdout.write(PS2 if more else PS1)
    sys.stdout.flush()


def answer_query(payload):
    try:
        qid, expr = json.loads(payload)
    except ValueError:
        return
    try:
        answer = [qid, True, str(eval(expr, namespace))]
    except BaseException as exc:  # noqa: BLE001  (the error text goes back to the IDE)
        answer = [qid, False, "".join(traceback.format_exception_only(type(exc), exc)).strip()]
    sys.stdout.write("\x02q" + json.dumps(answer) + "\x03")
    sys.stdout.flush()


def flush_plots():
    backend = sys.modules.get("pyide_sciview_backend")
    if backend is not None:
        try:
            backend.flush_figures()
        except Exception:  # noqa: BLE001
            traceback.print_exc()


def run_block(source):
    try:
        tree = ast.parse(source, "<input>", "exec")
    except SyntaxError:
        console.showsyntaxerror("<input>")
        return
    for stmt in tree.body:
        try:
            compiled = compile(ast.Interactive(body=[stmt]), "<input>", "single")
        except SyntaxError:
            console.showsyntaxerror("<input>")
            return
        try:
            exec(compiled, namespace)
        except SystemExit:
            raise
        except BaseException:
            console.showtraceback()
            return


def main():
    fd = sys.__stdin__.fileno()
    threading.Thread(target=read_stdin, args=(fd, pipe_peek(fd)), daemon=True).start()
    sys.stdin = ConsoleInput()
    sys.stdout.write("Python %s on %s\n" % (sys.version, sys.platform))
    prompt(False)
    more = False
    while True:
        try:
            line = next_line()
            if not line:
                break
            line = line.rstrip("\r\n")
            if line.startswith("\x05"):
                run(answer_query, line[1:])
                continue
            if line == INTERRUPT:
                raise KeyboardInterrupt
            if line.startswith("\x01"):
                console.resetbuffer()
                try:
                    source = json.loads(line[1:])
                except ValueError:
                    source = line[1:]
                run(run_block, source)
                more = False
            else:
                more = run(console.push, line)
            if not more:
                flush_plots()
        except SystemExit:
            break
        except KeyboardInterrupt:
            # Also an Interrupt that arrived just as a statement ended.
            console.resetbuffer()
            sys.stderr.write("KeyboardInterrupt\n")
            more = False
        try:
            prompt(more)
        except KeyboardInterrupt:
            prompt(False)


main()
