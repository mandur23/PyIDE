"""Starts ipykernel like `python -m ipykernel_launcher`, with interrupts that also wake blocking calls on Windows.

ipykernel interrupts a Windows kernel with _thread.interrupt_main(), which only sets Python's SIGINT flag, so
time.sleep() or a blocking wait keeps running until it returns by itself. signal.raise_signal() runs the C-level
handler, which also sets the event those calls wait on, so they stop at once as they do on Ctrl+C in a console.
"""
import signal
import sys

if __name__ == "__main__":
    # This folder is not part of the user's code; the kernel adds the working directory back itself.
    del sys.path[0]
    if sys.platform == "win32" and hasattr(signal, "raise_signal"):
        try:
            from ipykernel import parentpoller

            parentpoller.interrupt_main = lambda: signal.raise_signal(signal.SIGINT)
        except Exception:  # noqa: BLE001  (fall back to ipykernel's own interrupt)
            pass

    from ipykernel import kernelapp

    kernelapp.launch_new_instance()
