import os
import sys

name = __name__
print(f"module: {name} package: {__package__}")
print(f"cwd: {os.path.basename(os.getcwd())}")
print("argv: " + " ".join(sys.argv[1:]))
