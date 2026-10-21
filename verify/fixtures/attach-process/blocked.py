import time

# Blocked in one long native call: injected code runs only once the interpreter executes Python code again.
time.sleep(300)
