# Never imported or run by the diagram: if it were, PWNED.txt would appear next to it.
import pathlib

pathlib.Path(__file__).with_name("PWNED.txt").write_text("executed")


class Danger:
    pass
