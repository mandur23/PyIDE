import pathlib
import sys
import time

# Writes the current time (ms) to the file named by the first argument; the second is the exit code.
pathlib.Path(sys.argv[1]).write_text(str(time.time_ns() // 1_000_000))
print('marker', sys.argv[1])
sys.exit(int(sys.argv[2]) if len(sys.argv) > 2 else 0)
