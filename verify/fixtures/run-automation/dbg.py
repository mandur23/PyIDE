import pathlib
import time

pathlib.Path('debugged.txt').write_text(str(time.time_ns() // 1_000_000))
print('debugged')
