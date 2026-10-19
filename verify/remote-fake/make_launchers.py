"""make_launchers.py OUT_DIR: writes wsl.exe, ssh.exe and docker.exe into OUT_DIR, each running fakeremote.py with
this Python. They are pip's console-script launchers (distlib's t64.exe + shebang + a zip with __main__.py), real
.exe files, so PyIDE finds them on PATH exactly where it would find the real tools."""
import io
import os
import sys
import zipfile

import pip._vendor.distlib as distlib

here = os.path.dirname(os.path.abspath(__file__))
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
with open(os.path.join(os.path.dirname(distlib.__file__), "t64.exe"), "rb") as f:
    launcher = f.read()
for tool in ("wsl", "ssh", "docker"):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("__main__.py", "import sys\nsys.path.insert(0, %r)\nimport fakeremote\nfakeremote.main(%r)\n" % (here, tool))
    shebang = ('#!"%s"\r\n' % sys.executable).encode("utf-8")
    with open(os.path.join(out, tool + ".exe"), "wb") as f:
        f.write(launcher + shebang + buf.getvalue())
print(out)
