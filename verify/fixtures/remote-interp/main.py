import os
import platform
import sys

from helper import scale


def main():
    value = scale(21)
    print("answer", value)
    print("system", platform.system(), os.environ.get("FAKE_TARGET", ""))
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "data.txt"), encoding="utf-8") as f:
        print("data", f.read().strip())
    print("argv", " ".join(sys.argv[1:]))


main()
