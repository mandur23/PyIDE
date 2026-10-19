"""PyIDE Python Console backend.

Reads raw lines from stdin. A plain line is pushed to an InteractiveConsole like a typed line. A line starting with
\x01 carries a JSON-encoded block (Execute Selection in Console) that runs statement by statement in 'single' mode, so
expression values are echoed the way the interactive prompt does. After every step the console prints a prompt
marker (\x02ps1\x03 or \x02ps2\x03) on stdout so the IDE knows when it is ready and which prompt to show.

A line starting with \x05 is a query from the IDE (the Variables pane, the Data View): JSON [id, expression]. The
expression is evaluated in the console namespace and the answer comes back as \x02q[id, ok, text]\x03 without a
prompt, so a block being typed keeps its state. After each statement, figures for PyIDE's Plots window are flushed
when its matplotlib backend (pyide_sciview_backend) is in use.
"""
import ast
import code
import json
import sys
import traceback

PS1 = "\x02ps1\x03"
PS2 = "\x02ps2\x03"

for root in reversed(sys.argv[1:]):
    if root not in sys.path:
        sys.path.insert(0, root)
if "" not in sys.path:
    sys.path.insert(0, "")
sys.argv = [""]

namespace = {"__name__": "__main__", "__doc__": None}
console = code.InteractiveConsole(namespace, filename="<input>")


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
    sys.stdout.write("Python %s on %s\n" % (sys.version, sys.platform))
    prompt(False)
    more = False
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.rstrip("\r\n")
        if line.startswith("\x05"):
            answer_query(line[1:])
            continue
        try:
            if line.startswith("\x01"):
                console.resetbuffer()
                try:
                    source = json.loads(line[1:])
                except ValueError:
                    source = line[1:]
                run_block(source)
                more = False
            else:
                more = console.push(line)
        except SystemExit:
            break
        except KeyboardInterrupt:
            console.resetbuffer()
            sys.stderr.write("KeyboardInterrupt\n")
            more = False
        if not more:
            flush_plots()
        prompt(more)


main()
