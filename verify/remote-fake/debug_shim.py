"""Runs `python -m debugpy ARGS` for a fake target (fakeremote.py). In a real target the files debugpy runs have
target paths; here they are the local files behind the fake's mounts. The IDE's attach pathMappings name target
paths (/mnt/c/..., /opt/project, /home/...), so this translates their server side to the local folders, which is
what the target's filesystem would do."""
import json
import os
import runpy
import sys

mounts = sorted(json.loads(os.environ.pop("FAKE_MOUNTS")), key=lambda m: -len(m[0]))


def local(p):
    for prefix, folder in mounts:
        if p == prefix or p.startswith(prefix.rstrip("/") + "/"):
            rest = p[len(prefix):].lstrip("/")
            return os.path.join(folder, *rest.split("/")) if rest else folder
    return p


import debugpy._vendored.force_pydevd  # noqa: E402,F401  (puts pydevd on sys.path, as debugpy itself does)
import pydevd_file_utils  # noqa: E402

_setup = pydevd_file_utils.setup_client_server_paths


def setup_client_server_paths(paths):
    return _setup([(client, local(server)) for client, server in paths])


pydevd_file_utils.setup_client_server_paths = setup_client_server_paths
sys.argv = ["debugpy"] + sys.argv[1:]
runpy.run_module("debugpy", run_name="__main__", alter_sys=True)
