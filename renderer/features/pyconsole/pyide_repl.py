"""PyIDE Python Console backend.

Reads raw lines from stdin. A plain line is pushed to an InteractiveConsole like a typed line. A line starting with
\x01 carries a JSON-encoded block (Execute Selection in Console) that runs statement by statement in 'single' mode, so
expression values are echoed the way the interactive prompt does. After every step the console prints a prompt
marker (\x02ps1\x03 or \x02ps2\x03) on stdout so the IDE knows when it is ready and which prompt to show.
"""
import ast
import code
import json
import sys

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
        prompt(more)


main()
