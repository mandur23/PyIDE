import os
import sys

from calc import add


def main():
    print("args:", " ".join(sys.argv[1:]))
    print("env:", os.environ.get("GREETING", "<unset>"))
    print("cwd:", os.path.basename(os.getcwd()))
    print("sum:", add(2, 3))


if __name__ == "__main__":
    main()
