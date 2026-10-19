"""PyIDE's target-side helper for remote interpreters, run as `python -c <this file> COMMAND ...`.

manifest ROOT [EXT ...]  JSON {relpath: [size, mtime]} of the files under ROOT (only those ending in EXT when given)
pack ROOT                reads a JSON list of relpaths on stdin and writes those files to stdout as a stream
unpack ROOT              reads a stream on stdin and writes (or deletes) files under ROOT
libs                     JSON {version, prefix, platform, paths}: the interpreter's library folders, for Pyright
freeport                 a free TCP port on 127.0.0.1
waitport ADDR SECONDS    prints "listening" once something listens on ADDR's port (without connecting to it)

A stream is gzip-compressed. Each file is a JSON header line {"p": relpath, "n": size, "m": mtime, "x": executable}
followed by its n bytes; a header {"d": relpath} deletes that file instead.
"""
import gzip
import json
import os
import socket
import sys
import sysconfig

SKIP = {".git", "__pycache__", "node_modules", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".idea", ".venv", "venv", "env"}


def target(root, rel):
    parts = rel.split("/")
    if not rel or rel.startswith("/") or ".." in parts:
        raise ValueError("unsafe path: %r" % rel)
    return os.path.join(root, *parts)


def manifest(root, exts):
    out = {}
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in SKIP and not os.path.exists(os.path.join(d, x, "pyvenv.cfg"))]
        for f in files:
            if exts and not f.endswith(exts) and f != "py.typed":
                continue
            p = os.path.join(d, f)
            try:
                st = os.stat(p)
            except OSError:
                continue
            out[os.path.relpath(p, root).replace(os.sep, "/")] = [st.st_size, int(st.st_mtime)]
    json.dump(out, sys.stdout)


def pack(root):
    rels = json.load(sys.stdin)
    out = gzip.GzipFile(fileobj=sys.stdout.buffer, mode="wb", compresslevel=6)
    for rel in rels:
        p = target(root, rel)
        try:
            with open(p, "rb") as f:
                data = f.read()
            mtime = int(os.stat(p).st_mtime)
        except OSError:
            continue
        out.write((json.dumps({"p": rel, "n": len(data), "m": mtime}) + "\n").encode("utf-8"))
        out.write(data)
    out.close()
    sys.stdout.buffer.flush()


def unpack(root):
    z = gzip.GzipFile(fileobj=sys.stdin.buffer, mode="rb")
    written = 0
    while True:
        line = z.readline()
        if not line:
            break
        h = json.loads(line)
        if "d" in h:
            try:
                os.remove(target(root, h["d"]))
            except OSError:
                pass
            continue
        dest = target(root, h["p"])
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        data = z.read(h["n"])
        with open(dest, "wb") as f:
            f.write(data)
        if h.get("x"):
            os.chmod(dest, 0o755)
        os.utime(dest, (h["m"], h["m"]))
        written += 1
    print(written)


def libs():
    paths = sysconfig.get_paths()
    std = {os.path.realpath(p) for p in (paths.get("stdlib"), paths.get("platstdlib"), sys.prefix, sys.base_prefix) if p}
    found = []
    for p in sys.path:
        if not p or not os.path.isdir(p):
            continue
        rp = os.path.realpath(p)
        site = "site-packages" in rp or "dist-packages" in rp
        if rp in std or os.path.basename(rp) == "lib-dynload" or (not site and any(rp.startswith(s + os.sep) for s in std)):
            continue
        if rp not in found:
            found.append(rp)
    json.dump({"version": list(sys.version_info), "prefix": sys.prefix, "platform": sys.platform, "paths": found}, sys.stdout)


def freeport():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    print(s.getsockname()[1])
    s.close()


def listening(port):
    # /proc/net/tcp* on Linux (state 0A = LISTEN); netstat elsewhere. Connecting would consume debugpy's one client.
    found = False
    for name in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(name) as f:
                rows = f.read().splitlines()[1:]
        except OSError:
            continue
        found = True
        for row in rows:
            cols = row.split()
            if len(cols) > 3 and cols[3] == "0A" and int(cols[1].rsplit(":", 1)[1], 16) == port:
                return True
    if found:
        return False
    import re
    import subprocess
    try:
        out = subprocess.run(["netstat", "-an"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return re.search(r"[.:]%d\s.*LISTEN" % port, out) is not None


def waitport(addr, seconds):
    import time
    port = int(addr.rsplit(":", 1)[1])
    end = time.time() + seconds
    while time.time() < end:
        if listening(port):
            print("listening")
            return
        time.sleep(0.2)


cmd = sys.argv[1]
if cmd == "manifest":
    manifest(sys.argv[2], tuple(sys.argv[3:]))
elif cmd == "pack":
    pack(sys.argv[2])
elif cmd == "unpack":
    unpack(sys.argv[2])
elif cmd == "libs":
    libs()
elif cmd == "freeport":
    freeport()
elif cmd == "waitport":
    waitport(sys.argv[2], float(sys.argv[3]))
else:
    sys.exit("unknown command %r" % cmd)
