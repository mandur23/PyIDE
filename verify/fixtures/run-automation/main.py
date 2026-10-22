import pathlib
import time

pathlib.Path('main.txt').write_text(str(time.time_ns() // 1_000_000))
print('main ran')
