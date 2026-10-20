import os

for name in ("FOO", "EXPANDED", "LITERAL", "OVERRIDE", "ALT"):
    print(f"{name}=[{os.environ.get(name, '<unset>')}]")
