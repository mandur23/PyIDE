"""Runs a Python command line under cProfile and writes the statistics as JSON for PyIDE's Profiler tool window.

Usage: python -u pyide_profile_run.py <stats.json> -- <interpreter arguments>

The interpreter arguments are the ones a run configuration passes to Python: options such as -u, then a script,
-m module or -c code, then the program's arguments. -c code runs without profiling (the IDE uses it for probes).

The JSON lists every function with cProfile's numbers (nc: calls, cc: primitive calls, tt: own time, ct: total
time, in seconds), its callers as [index, nc, cc, tt, ct], and `root` [nc, cc, tt, ct] for calls that came from
outside the program. Frames of this script, runpy and the profiler are left out, and the program's top-level code
(the script's or module's <module>) is a root instead of a callee of runpy's exec().
"""
import cProfile
import importlib.util
import json
import os
import pstats
import runpy
import sys
import traceback

# runpy is a frozen module in recent Pythons, so its frames name '<frozen runpy>' instead of its file.
SKIP_FRAMES = {os.path.normcase(os.path.abspath(__file__)), os.path.normcase(runpy.__file__), '<frozen runpy>'}
EXEC = ('~', 0, '<built-in method builtins.exec>')


def parse(argv):
    i = 0
    while i < len(argv) and argv[i].startswith('-') and argv[i] not in ('-m', '-c', '-'):
        i += 2 if argv[i] in ('-X', '-W') else 1
    if i >= len(argv):
        raise SystemExit('pyide_profile_run: nothing to run')
    if argv[i] in ('-m', '-c'):
        return argv[i], argv[i + 1], argv[i + 2:]
    return 'script', argv[i], argv[i + 1:]


def target_file(kind, target):
    """The file whose top-level code runs: the script, or the module (a package's __main__) that -m runs."""
    if kind == 'script':
        return os.path.abspath(target)
    try:
        spec = importlib.util.find_spec(target)
        if spec and spec.submodule_search_locations is not None:
            spec = importlib.util.find_spec(f'{target}.__main__')
        return spec.origin if spec else None
    except Exception:
        return None


def run(kind, target, args, profiler=None):
    """Runs the target like the interpreter would and returns its exit code."""
    try:
        if kind == '-c':
            sys.argv = ['-c', *args]
            sys.path[0] = ''
            exec(compile(target, '<string>', 'exec'), {'__name__': '__main__', '__builtins__': __builtins__})
            return 0
        sys.argv = [target, *args]
        profiler.enable()
        try:
            if kind == '-m':
                runpy.run_module(target, run_name='__main__', alter_sys=True)
            else:
                runpy.run_path(target, run_name='__main__')
        finally:
            profiler.disable()
    except SystemExit as e:
        if e.code is None or isinstance(e.code, int):
            return e.code or 0
        print(e.code, file=sys.stderr)
        return 1
    except BaseException as e:
        tb = e.__traceback__
        while tb and os.path.normcase(tb.tb_frame.f_code.co_filename) in SKIP_FRAMES:
            tb = tb.tb_next
        traceback.print_exception(type(e), e, tb)
        return 1
    return 0


def infrastructure(func):
    file, _line, name = func
    return os.path.normcase(file) in SKIP_FRAMES or (file == '~' and '_lsprof.Profiler' in name)


def add(total, part):
    for i, v in enumerate(part):
        total[i] += v


def write_stats(profiler, cwd, main_file, out):
    # (file, line, name) -> [cc, nc, tt, ct, {caller: [nc, cc, tt, ct]}]
    funcs = {f: [cc, nc, tt, ct, {c: list(v[:4]) for c, v in callers.items()}]
             for f, (cc, nc, tt, ct, callers) in pstats.Stats(profiler).stats.items()}
    roots = {f: [0, 0, 0.0, 0.0] for f in funcs}
    # Calls made before the profiler was enabled have no recorded caller.
    for f, (cc, nc, tt, ct, callers) in funcs.items():
        missing = nc - sum(v[0] for v in callers.values())
        if missing > 0:
            add(roots[f], [missing, missing, max(0.0, tt - sum(v[2] for v in callers.values())),
                           max(0.0, ct - sum(v[3] for v in callers.values()))])
    # The program's top-level code was exec()'d by runpy: make it a root and take that call out of exec's numbers.
    top = next((f for f in funcs if f[2] == '<module>' and main_file
                and os.path.normcase(os.path.abspath(f[0])) == os.path.normcase(main_file)), None)
    if top and EXEC in funcs[top][4]:
        edge = funcs[top][4].pop(EXEC)
        add(roots[top], edge)
        ex = funcs[EXEC]
        ex[1] -= edge[0]
        ex[0] -= edge[1]
        ex[3] -= edge[3]
        for c, v in ex[4].items():
            if infrastructure(c):
                take = min(v[0], edge[0])
                v[0] -= take
                v[1] = max(0, v[1] - take)
                v[3] = max(0.0, v[3] - edge[3])
        ex[4] = {c: v for c, v in ex[4].items() if v[0] > 0}
    dropped = {f for f in funcs if infrastructure(f) or (f == EXEC and funcs[f][1] <= 0)}
    # Calls from dropped frames (runpy setting up the program) count as calls from outside.
    for f, entry in funcs.items():
        for c in [c for c in entry[4] if c in dropped]:
            add(roots[f], entry[4].pop(c))
    kept = [f for f in funcs if f not in dropped]
    index = {f: i for i, f in enumerate(kept)}
    functions = []
    for f in kept:
        cc, nc, tt, ct, callers = funcs[f]
        file, line, name = f
        if file not in ('~', '') and not file.startswith('<'):
            file = os.path.normpath(os.path.join(cwd, file))
        functions.append({
            'file': file, 'line': line, 'name': name, 'nc': nc, 'cc': cc, 'tt': tt, 'ct': ct,
            'callers': [[index[c], *v] for c, v in callers.items()],
            'root': roots[f] if roots[f][0] > 0 else None,
        })
    tmp = out + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump({'functions': functions, 'total': sum(fn['tt'] for fn in functions)}, fh)
    os.replace(tmp, out)


def main():
    out = sys.argv[1]
    kind, target, args = parse(sys.argv[sys.argv.index('--') + 1:])
    if kind == '-c':
        return run(kind, target, args)
    cwd = os.getcwd()
    # sys.path[0] as the interpreter sets it, before the -m target is looked up.
    sys.path[0] = cwd if kind == '-m' else os.path.dirname(os.path.abspath(target))
    main_file = target_file(kind, target)
    profiler = cProfile.Profile()
    try:
        return run(kind, target, args, profiler)
    finally:
        write_stats(profiler, cwd, main_file, out)


if __name__ == '__main__':
    sys.exit(main())
