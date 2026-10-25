import sys

data = sys.stdin.read()
print("GOT", repr(data), sys.stdin.isatty())
