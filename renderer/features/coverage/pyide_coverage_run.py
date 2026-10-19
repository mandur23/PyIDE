"""Runs a Python command line under coverage.py and writes a summary for PyIDE's Coverage tool window.

Usage: python -u pyide_coverage_run.py <data file> <summary.json> <source root> -- <interpreter arguments>

The interpreter arguments are the ones a run configuration passes to Python: options such as -u, then a script,
-m module or -c code, then the program's arguments. Scripts and modules run in this process with line and branch
coverage measured for files under the source root. -c code runs without measuring (the IDE uses it for probes).
"""
import json
import os
import runpy
import sys
import traceback

# runpy is a frozen module in recent Pythons, so its frames name '<frozen runpy>' instead of its file.
SKIP_FRAMES = {os.path.normcase(os.path.abspath(__file__)), os.path.normcase(runpy.__file__), '<frozen runpy>'}


def parse(argv):
    i = 0
    while i < len(argv) and argv[i].startswith('-') and argv[i] not in ('-m', '-c', '-'):
        i += 2 if argv[i] in ('-X', '-W') else 1
    if i >= len(argv):
        raise SystemExit('pyide_coverage_run: nothing to run')
    if argv[i] in ('-m', '-c'):
        return argv[i], argv[i + 1], argv[i + 2:]
    return 'script', argv[i], argv[i + 1:]


def run(kind, target, args):
    """Runs the target like the interpreter would and returns its exit code."""
    try:
        if kind == '-c':
            sys.argv = ['-c', *args]
            sys.path[0] = ''
            exec(compile(target, '<string>', 'exec'), {'__name__': '__main__', '__builtins__': __builtins__})
        elif kind == '-m':
            sys.argv = [target, *args]
            sys.path[0] = os.getcwd()
            runpy.run_module(target, run_name='__main__', alter_sys=True)
        else:
            sys.argv = [target, *args]
            sys.path[0] = os.path.dirname(os.path.abspath(target))
            runpy.run_path(target, run_name='__main__')
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


def summarize(cov, cwd, summary_file):
    import coverage
    report = summary_file + '.report.json'
    files = {}
    try:
        cov.json_report(outfile=report)
        with open(report, encoding='utf-8') as f:
            data = json.load(f)
        os.remove(report)
    except coverage.CoverageException:
        data = {'files': {}}
    for name, info in data.get('files', {}).items():
        s = info['summary']
        executed = info.get('executed_lines', [])
        missing = info.get('missing_lines', [])
        arcs = {}  # line -> [taken, total] for lines that branch
        for a, b in info.get('executed_branches', []):
            arcs.setdefault(a, [0, 0])
            arcs[a][0] += 1
            arcs[a][1] += 1
        for a, b in info.get('missing_branches', []):
            arcs.setdefault(a, [0, 0])
            arcs[a][1] += 1
        executed_set = set(executed)
        files[os.path.normpath(os.path.join(cwd, name))] = {
            'executed': executed,
            'missing': missing,
            'partial': {str(line): arc for line, arc in arcs.items() if arc[0] < arc[1] and line in executed_set},
            'statements': s.get('num_statements', 0),
            'covered': s.get('covered_lines', 0),
            'branches': s.get('num_branches', 0),
            'coveredBranches': s.get('covered_branches', 0),
        }
    tmp = summary_file + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump({'version': coverage.__version__, 'files': files}, f)
    os.replace(tmp, summary_file)


def main():
    data_file, summary_file, source = sys.argv[1:4]
    kind, target, args = parse(sys.argv[sys.argv.index('--') + 1:])
    if kind == '-c':
        return run(kind, target, args)
    import coverage
    cwd = os.getcwd()
    cov = coverage.Coverage(data_file=data_file, branch=True, source=[source or cwd])
    cov.set_option('run:disable_warnings', ['no-data-collected', 'module-not-imported', 'module-not-measured'])
    cov.start()
    try:
        code = run(kind, target, args)
    finally:
        cov.stop()
        cov.save()
        os.chdir(cwd)
        summarize(cov, cwd, summary_file)
    return code


if __name__ == '__main__':
    sys.exit(main())
